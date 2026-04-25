#!/usr/bin/env python3
"""
Interactive CLI for managing ShotCatcher users.

Run:  python manage_users.py [--db /path/to/users.db]
"""
from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth.user_db import UserDB

DEFAULT_DB_PATH = str(Path(__file__).resolve().parent.parent / "config" / "users.db")

# ── ANSI colours (disabled automatically if stdout isn't a tty) ───────────────
_TTY = sys.stdout.isatty()

def _c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _TTY else text

def green(t: str)  -> str: return _c("32", t)
def red(t: str)    -> str: return _c("31", t)
def yellow(t: str) -> str: return _c("33", t)
def bold(t: str)   -> str: return _c("1",  t)
def dim(t: str)    -> str: return _c("2",  t)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _prompt(msg: str, default: str = "") -> str:
    """Prompt with optional default shown in brackets."""
    suffix = f" [{default}]" if default else ""
    try:
        val = input(f"  {msg}{suffix}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        return default
    return val or default


def _ask_password(username: str, label: str = "Password") -> str | None:
    """Ask for password + confirmation. Returns None on cancel."""
    while True:
        try:
            pw = getpass.getpass(f"  {label} for '{username}': ")
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if not pw:
            print(red("  Cancelled."))
            return None
        if len(pw) < 8:
            print(red("  Must be at least 8 characters."))
            continue
        try:
            confirm = getpass.getpass("  Confirm password: ")
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if pw == confirm:
            return pw
        print(red("  Passwords do not match, try again."))


def _print_users(users: list[dict]) -> None:
    if not users:
        print(dim("  No users found."))
        return
    col = "{:<4}  {:<20}  {:<7}  {:<6}  {:<20}  {}"
    print(dim("  " + col.format("ID", "Username", "Role", "Active", "Created", "Last Login")))
    print(dim("  " + "-" * 82))
    for u in users:
        active  = green("yes") if u["is_active"] else red("no")
        role    = yellow(u["role"]) if u["role"] == "admin" else u["role"]
        created = (u["created_at"] or "")[:19]
        login   = (u["last_login"] or "never")[:19]
        print("  " + col.format(u["id"], u["username"], role, active, created, login))


# ── Actions ───────────────────────────────────────────────────────────────────

def action_list(db: UserDB) -> None:
    users = db.list_users()
    _print_users(users)


def action_add(db: UserDB) -> None:
    username = _prompt("Username")
    if not username:
        print(red("  Cancelled."))
        return
    role_raw = _prompt("Role (user/admin)", default="user").lower()
    role = "admin" if role_raw == "admin" else "user"
    pw = _ask_password(username, "Password")
    if pw is None:
        return
    try:
        uid = db.create_user(username, pw, role=role)
        print(green(f"  ✓ Created '{username}' (id={uid}, role={role})"))
    except ValueError as e:
        print(red(f"  Error: {e}"))


def action_remove(db: UserDB) -> None:
    users = db.list_users()
    _print_users(users)
    if not users:
        return
    username = _prompt("Username to delete")
    if not username:
        print(red("  Cancelled."))
        return
    confirm = _prompt(f"Type '{username}' again to confirm deletion")
    if confirm != username:
        print(red("  Cancelled — names did not match."))
        return
    ok = db.delete_user(username)
    if ok:
        print(green(f"  ✓ Deleted '{username}'"))
    else:
        print(red(f"  User '{username}' not found."))


def action_reset_password(db: UserDB) -> None:
    users = db.list_users()
    _print_users(users)
    if not users:
        return
    username = _prompt("Username")
    if not username:
        print(red("  Cancelled."))
        return
    pw = _ask_password(username, "New password")
    if pw is None:
        return
    ok = db.set_password(username, pw)
    if ok:
        print(green(f"  ✓ Password updated for '{username}'"))
    else:
        print(red(f"  User '{username}' not found."))


# ── Main menu ─────────────────────────────────────────────────────────────────

MENU = [
    ("List users",           action_list),
    ("Add user",             action_add),
    ("Delete user",          action_remove),
    ("Reset password",       action_reset_password),
    ("Exit",                 None),
]


def run_menu(db_path: str) -> None:
    db = UserDB(db_path)
    print(bold(f"\n  ShotCatcher — User Management"))
    print(dim(f"  DB: {db_path}\n"))

    try:
        while True:
            print()
            for i, (label, _) in enumerate(MENU, 1):
                print(f"  {bold(str(i))}.  {label}")
            print()

            raw = _prompt("Choose").strip()
            if not raw:
                continue

            try:
                idx = int(raw) - 1
            except ValueError:
                print(red("  Please enter a number."))
                continue

            if idx < 0 or idx >= len(MENU):
                print(red(f"  Enter 1–{len(MENU)}."))
                continue

            label, fn = MENU[idx]
            if fn is None:
                print(dim("  Bye!"))
                break

            print(f"\n  {bold('──')} {label} {bold('──')}")
            fn(db)
    except KeyboardInterrupt:
        print(dim("\n  Interrupted."))
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="ShotCatcher user management (interactive)")
    parser.add_argument(
        "--db", dest="db_path", default=DEFAULT_DB_PATH,
        metavar="DB_PATH",
        help=f"Path to users.db (default: {DEFAULT_DB_PATH})",
    )
    args = parser.parse_args()
    run_menu(args.db_path)


if __name__ == "__main__":
    main()
