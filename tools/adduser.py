#!/usr/bin/env python3
"""
用户管理脚本（只用 Python 3 标准库）。用户存放在 data/cet4.sqlite3 的 users 表。

  添加/更新用户:  python tools/adduser.py <用户名> <密码> [显示名称] [角色]
  删除用户:       python tools/adduser.py --remove <用户名>
  停用/启用:      python tools/adduser.py --disable <用户名>  /  --enable <用户名>
  列出用户:       python tools/adduser.py --list

密码使用 PBKDF2-SHA256（随机 16 字节盐，100000 次迭代）哈希后保存，不存明文，
与前端 js/auth.js 的校验算法一致。改完提交 data/cet4.sqlite3 即生效。
"""
import hashlib, os, re, sqlite3, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'data', 'cet4.sqlite3')
ITERATIONS = 100000
USERS_SCHEMA = """CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username VARCHAR(32) NOT NULL UNIQUE, name VARCHAR(64) DEFAULT '',
  role VARCHAR(20) DEFAULT 'user', salt VARCHAR(64) NOT NULL, hash VARCHAR(128) NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 100000, disabled BOOLEAN DEFAULT 0)"""


def connect():
    con = sqlite3.connect(DB)
    con.execute(USERS_SCHEMA)
    return con


def main(args):
    if not args:
        print(__doc__)
        return 1
    con = connect()
    if args[0] == '--list':
        print(f'{"用户名":12} {"显示名称":12} {"角色":6} 状态')
        for u, n, r, d in con.execute('SELECT username, name, role, disabled FROM users ORDER BY username'):
            print(f'{u:15} {n:12} {r:8} {"停用" if d else "正常"}')
        return 0
    if args[0] in ('--remove', '--disable', '--enable') and len(args) > 1:
        with con:
            if args[0] == '--remove':
                n = con.execute('DELETE FROM users WHERE username=?', (args[1],)).rowcount
            else:
                n = con.execute('UPDATE users SET disabled=? WHERE username=?', (1 if args[0] == '--disable' else 0, args[1])).rowcount
        if not n:
            print(f'未找到用户 {args[1]}')
            return 1
        print({'--remove': '已删除', '--disable': '已停用', '--enable': '已启用'}[args[0]], '用户', args[1])
        con.execute('VACUUM')
        return 0

    username, password = (args + [None, None])[:2]
    name = args[2] if len(args) > 2 else username
    role = args[3] if len(args) > 3 else 'user'
    if not username or not password:
        print('用法: python tools/adduser.py <用户名> <密码> [显示名称] [角色]')
        return 1
    if not re.fullmatch(r'[\w.-]{2,32}', username, re.ASCII):
        print('用户名只能包含字母、数字、下划线、点和短横线，长度 2-32')
        return 1
    if len(password) < 6:
        print('密码长度至少 6 位')
        return 1
    salt = os.urandom(16)
    h = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, ITERATIONS, 32).hex()
    with con:
        exists = con.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone()
        if exists:
            con.execute('UPDATE users SET name=?, role=?, salt=?, hash=?, iterations=?, disabled=0 WHERE username=?',
                        (name, role, salt.hex(), h, ITERATIONS, username))
        else:
            con.execute('INSERT INTO users(username,name,role,salt,hash,iterations) VALUES (?,?,?,?,?,?)',
                        (username, name, role, salt.hex(), h, ITERATIONS))
    con.execute('VACUUM')
    print(f'{"已更新" if exists else "已添加"}用户 {username}（{name}）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
