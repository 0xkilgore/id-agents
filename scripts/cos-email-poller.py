#!/usr/bin/env python3
"""Chief-of-Staff email intake poller.

Small, de-personalized lift of the Cane IMAP poller shape:
- connect to an IMAP mailbox
- parse new RFC822 messages
- track seen UIDs in a JSON state file
- POST each forwarded message to the manager's /inbox/email/ingest route

Required env:
  COS_EMAIL_IMAP_HOST
  COS_EMAIL_IMAP_USER
  COS_EMAIL_IMAP_PASS

Optional env:
  COS_EMAIL_IMAP_PORT       default: 993
  COS_EMAIL_IMAP_MAILBOX    default: INBOX
  COS_EMAIL_MANAGER_URL     default: http://127.0.0.1:4100
  COS_EMAIL_TEAM            optional X-Id-Team header value
  COS_EMAIL_STATE_FILE      default: ~/.id-agents/cos-email-poller-state.json
  COS_EMAIL_DEFAULT_TO      fallback recipient when delivery headers are absent
"""

from __future__ import annotations

import argparse
import email
import email.utils
import html
import imaplib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path
from typing import Any


HTML_HINT_RE = re.compile(r"<\s*(?:html|!doctype|body|table|div|p|br|td)\b", re.I)


def state_path() -> Path:
    raw = os.environ.get("COS_EMAIL_STATE_FILE")
    if raw:
        return Path(raw).expanduser()
    return Path("~/.id-agents/cos-email-poller-state.json").expanduser()


def load_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {"seen_uids": []}
    except json.JSONDecodeError:
        return {"seen_uids": []}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True))
    tmp.replace(path)


def connect_imap() -> imaplib.IMAP4_SSL:
    host = required_env("COS_EMAIL_IMAP_HOST")
    user = required_env("COS_EMAIL_IMAP_USER")
    password = required_env("COS_EMAIL_IMAP_PASS")
    port = int(os.environ.get("COS_EMAIL_IMAP_PORT", "993"))
    mailbox = os.environ.get("COS_EMAIL_IMAP_MAILBOX", "INBOX")
    mail = imaplib.IMAP4_SSL(host, port)
    mail.login(user, password)
    mail.select(mailbox)
    return mail


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"missing required env: {name}")
    return value


def html_to_text(value: str) -> str:
    value = re.sub(r"(?is)<script\b.*?</script>", " ", value)
    value = re.sub(r"(?is)<style\b.*?</style>", " ", value)
    value = re.sub(r"(?is)<!--.*?-->", " ", value)
    value = re.sub(r"(?i)<\s*br\s*/?>", "\n", value)
    value = re.sub(r"(?i)</\s*(?:p|div|tr|table|li|h[1-6]|ul|ol)\s*>", "\n", value)
    value = re.sub(r"<[^>]+>", "", value)
    value = html.unescape(value).replace("\xa0", " ")
    return "\n".join(line.strip() for line in value.splitlines() if line.strip())


def get_email_body(msg: Message) -> str:
    if msg.is_multipart():
        for content_type in ("text/plain", "text/html"):
            for part in msg.walk():
                if part.get_content_type() != content_type:
                    continue
                payload = part.get_payload(decode=True)
                if not payload:
                    continue
                charset = part.get_content_charset() or "utf-8"
                text = payload.decode(charset, errors="replace")
                if content_type == "text/html" or HTML_HINT_RE.search(text):
                    return html_to_text(text)
                return text.strip()
    payload = msg.get_payload(decode=True)
    if not payload:
        return ""
    charset = msg.get_content_charset() or "utf-8"
    text = payload.decode(charset, errors="replace")
    return html_to_text(text) if msg.get_content_type() == "text/html" or HTML_HINT_RE.search(text) else text.strip()


def first_address(value: str | None) -> str | None:
    parsed = email.utils.getaddresses([value or ""])
    for _name, addr in parsed:
        if addr:
            return addr
    return None


def recipient_for_manager(msg: Message) -> str:
    for header in ("Delivered-To", "X-Original-To", "X-Forwarded-To", "To"):
        addr = first_address(msg.get(header))
        if addr:
            return addr
    fallback = os.environ.get("COS_EMAIL_DEFAULT_TO", "").strip()
    if fallback:
        return fallback
    raise ValueError("message has no recipient header and COS_EMAIL_DEFAULT_TO is unset")


def fetch_new_emails(mail: imaplib.IMAP4_SSL, seen_uids: set[str]) -> list[dict[str, Any]]:
    status, data = mail.uid("search", None, "ALL")
    if status != "OK":
        raise RuntimeError(f"imap search failed: {status}")
    out: list[dict[str, Any]] = []
    for uid_raw in data[0].split():
        uid = uid_raw.decode()
        if uid in seen_uids:
            continue
        status, msg_data = mail.uid("fetch", uid_raw, "(RFC822)")
        if status != "OK" or not msg_data or not msg_data[0]:
            continue
        raw = msg_data[0][1]
        msg = email.message_from_bytes(raw)
        out.append({
            "uid": uid,
            "to": recipient_for_manager(msg),
            "from": first_address(msg.get("From")),
            "subject": msg.get("Subject") or "(no subject)",
            "text": get_email_body(msg),
            "message_id": msg.get("Message-ID") or f"imap-uid:{uid}",
            "received_at": parsed_date_iso(msg.get("Date")),
        })
    return out


def parsed_date_iso(value: str | None) -> str | None:
    if not value:
        return None
    parsed = email.utils.parsedate_to_datetime(value)
    if parsed is None:
        return None
    return parsed.isoformat()


def post_to_manager(item: dict[str, Any]) -> dict[str, Any]:
    base = os.environ.get("COS_EMAIL_MANAGER_URL", "http://127.0.0.1:4100").rstrip("/")
    body = json.dumps({
        "to": item["to"],
        "from": item.get("from"),
        "subject": item.get("subject"),
        "text": item.get("text"),
        "message_id": item.get("message_id"),
        "received_at": item.get("received_at"),
    }).encode()
    headers = {"content-type": "application/json"}
    team = os.environ.get("COS_EMAIL_TEAM", "").strip()
    if team:
        headers["X-Id-Team"] = team
    req = urllib.request.Request(
        f"{base}/inbox/email/ingest",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"manager ingest failed: HTTP {exc.code} {detail}") from exc


def poll_once(backfill_existing: bool = False) -> int:
    path = state_path()
    state = load_state(path)
    seen = set(str(uid) for uid in state.get("seen_uids", []))
    with connect_imap() as mail:
        emails = fetch_new_emails(mail, seen)
    if backfill_existing and not seen:
        state["seen_uids"] = sorted({item["uid"] for item in emails}, key=uid_sort_key)
        save_state(path, state)
        return 0

    delivered = 0
    for item in emails:
        result = post_to_manager(item)
        print(json.dumps({"uid": item["uid"], "result": result}, sort_keys=True))
        seen.add(item["uid"])
        delivered += 1
    state["seen_uids"] = sorted(seen, key=uid_sort_key)
    save_state(path, state)
    return delivered


def uid_sort_key(value: str) -> tuple[int, str]:
    return (int(value), "") if value.isdigit() else (0, value)


def main() -> int:
    parser = argparse.ArgumentParser(description="Poll IMAP and forward messages into CoS email intake")
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    parser.add_argument("--interval", type=int, default=int(os.environ.get("COS_EMAIL_POLL_INTERVAL", "60")))
    parser.add_argument("--backfill-existing", action="store_true", help="on first run, mark current mailbox messages seen")
    args = parser.parse_args()

    if args.once:
        return poll_once(backfill_existing=args.backfill_existing)
    while True:
        try:
            poll_once(backfill_existing=args.backfill_existing)
        except Exception as exc:  # noqa: BLE001
            print(f"cos-email-poller error: {exc}", file=sys.stderr)
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
