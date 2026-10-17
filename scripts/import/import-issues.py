#!/usr/bin/env python3
"""
Imports all issues from awesome-opencode/awesome-opencode to Heretek-AI/awesome-opencode
using the GitHub Issue Import API (golden-comet-preview) to preserve timestamps,
closed status, and comments without generating spam notifications.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

UPSTREAM_REPO = "awesome-opencode/awesome-opencode"
TARGET_REPO = "Heretek-AI/awesome-opencode"
MAPPING_FILE = os.path.join(os.path.dirname(__file__), "upstream_issues_map.json")

def get_token():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        try:
            token = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
        except Exception as e:
            sys.exit(f"Failed to get GitHub token via gh CLI: {e}")
    return token

TOKEN = get_token()

def gh_api_request(url, method="GET", data=None, accept="application/vnd.github.v3+json"):
    headers = {
        "Authorization": f"token {TOKEN}",
        "Accept": accept,
        "User-Agent": "Heretek-HardFork-Migration"
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"HTTPError {e.code} for {method} {url}: {error_body}", file=sys.stderr)
        raise

def sanitize_mentions(text):
    if not text:
        return ""
    # Avoid triggering accidental @mentions by converting @username to markdown links
    # but ignore email addresses (e.g. user@domain.com) and code blocks
    def replace_mention(match):
        prefix = match.group(1)
        username = match.group(2)
        return f"{prefix}[@{username}](https://github.com/{username})"

    # Match @username when preceded by start of line or whitespace
    return re.sub(r'(^|[\s(])@([a-zA-Z0-9_\-]+)', replace_mention, text)

def fetch_upstream_issues():
    print(f"Fetching issues from {UPSTREAM_REPO}...")
    issues = []
    page = 1
    while True:
        url = f"https://api.github.com/repos/{UPSTREAM_REPO}/issues?state=all&per_page=100&page={page}&direction=asc"
        items = gh_api_request(url)
        if not items:
            break
        for item in items:
            if "pull_request" not in item:
                issues.append(item)
        page += 1
    
    issues.sort(key=lambda x: x["number"])
    print(f"Found {len(issues)} upstream issues (excluding PRs).")
    return issues

def fetch_comments(comments_url):
    all_comments = []
    page = 1
    while True:
        url = f"{comments_url}?per_page=100&page={page}"
        items = gh_api_request(url)
        if not items:
            break
        all_comments.extend(items)
        page += 1
    return all_comments

def import_issue(issue, comments):
    num = issue["number"]
    title = issue["title"]
    state = issue["state"].upper()
    author = issue["user"]["login"] if issue.get("user") else "unknown"
    created_at = issue["created_at"]
    closed_at = issue.get("closed_at")
    raw_body = issue.get("body") or "*No description provided.*"
    sanitized_body = sanitize_mentions(raw_body)

    provenance_banner = (
        f"> [!NOTE]\n"
        f"> **Imported from upstream issue**: [{UPSTREAM_REPO}#{num}](https://github.com/{UPSTREAM_REPO}/issues/{num})\n"
        f"> **Original Author**: [@{author}](https://github.com/{author})\n"
        f"> **Created At**: `{created_at}`\n"
        f"> **Original State**: `{state}`"
    )
    if closed_at:
        provenance_banner += f"\n> **Closed At**: `{closed_at}`"

    full_body = f"{provenance_banner}\n\n---\n\n{sanitized_body}"

    imported_comments = []
    for c in comments:
        c_author = c["user"]["login"] if c.get("user") else "unknown"
        c_created_at = c["created_at"]
        c_body = sanitize_mentions(c.get("body") or "")
        c_banner = f"> **Comment by [@{c_author}](https://github.com/{c_author}) on `{c_created_at}`**:"
        imported_comments.append({
            "created_at": c_created_at,
            "body": f"{c_banner}\n\n{c_body}"
        })

    payload = {
        "issue": {
            "title": f"[Upstream #{num}] {title}",
            "body": full_body,
            "created_at": created_at,
            "closed": (state == "CLOSED"),
            "labels": [l["name"] for l in issue.get("labels", [])]
        }
    }
    if closed_at and state == "CLOSED":
        payload["issue"]["closed_at"] = closed_at
    if imported_comments:
        payload["comments"] = imported_comments

    import_url = f"https://api.github.com/repos/{TARGET_REPO}/import/issues"
    res = gh_api_request(
        import_url,
        method="POST",
        data=payload,
        accept="application/vnd.github.golden-comet-preview+json"
    )
    
    poll_url = res.get("url")
    if not poll_url:
        return res

    # Poll status until imported
    for _ in range(30):
        time.sleep(1.0)
        status_res = gh_api_request(
            poll_url,
            method="GET",
            accept="application/vnd.github.golden-comet-preview+json"
        )
        status = status_res.get("status")
        if status == "imported":
            return status_res
        elif status == "failed":
            print(f"Import failed for upstream #{num}: {status_res}", file=sys.stderr)
            return status_res

    return status_res

def load_mapping():
    if os.path.exists(MAPPING_FILE):
        with open(MAPPING_FILE, "r") as f:
            return json.load(f)
    return {}

def save_mapping(mapping):
    with open(MAPPING_FILE, "w") as f:
        json.dump(mapping, f, indent=2)

def main():
    mapping = load_mapping()
    issues = fetch_upstream_issues()
    print(f"Total upstream issues to process: {len(issues)}")

    for idx, issue in enumerate(issues, 1):
        num = issue["number"]
        if str(num) in mapping:
            print(f"[{idx}/{len(issues)}] Upstream #{num} already imported as {mapping[str(num)]['issue_url']}. Skipping.")
            continue

        print(f"[{idx}/{len(issues)}] Importing Upstream #{num}: {issue['title'][:50]}...")
        comments = []
        if issue.get("comments", 0) > 0 and issue.get("comments_url"):
            comments = fetch_comments(issue["comments_url"])

        retries = 3
        while retries > 0:
            try:
                res = import_issue(issue, comments)
                issue_url = res.get("issue_url")
                print(f"  ✓ Imported upstream #{num} -> {issue_url}")
                mapping[str(num)] = {
                    "upstream_number": num,
                    "title": issue["title"],
                    "state": issue["state"],
                    "import_id": res.get("id"),
                    "issue_url": issue_url
                }
                save_mapping(mapping)
                time.sleep(1.5)  # Avoid secondary rate limits
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 429):
                    print("  Rate limited, sleeping 30s...", file=sys.stderr)
                    time.sleep(30)
                    retries -= 1
                else:
                    print(f"  Error importing #{num}: {e}", file=sys.stderr)
                    break
            except Exception as e:
                print(f"  Unexpected error importing #{num}: {e}", file=sys.stderr)
                time.sleep(2)
                retries -= 1

    print("\nIssue migration complete!")
    print(f"Total imported issues: {len(mapping)} / {len(issues)}")

if __name__ == "__main__":
    main()
