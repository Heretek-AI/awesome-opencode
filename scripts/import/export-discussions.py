#!/usr/bin/env python3
"""
Exports all 75 discussions from upstream awesome-opencode/awesome-opencode
to docs/archive/upstream-discussions.md for historical documentation and link preservation.
"""

import json
import os
import subprocess
import sys
import urllib.request

UPSTREAM_OWNER = "awesome-opencode"
UPSTREAM_NAME = "awesome-opencode"
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "../../docs/archive/upstream-discussions.md")

def get_token():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        try:
            token = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
        except Exception as e:
            sys.exit(f"Failed to get GitHub token: {e}")
    return token

TOKEN = get_token()

QUERY = """
query($cursor: String) {
  repository(owner: "awesome-opencode", name: "awesome-opencode") {
    discussions(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        number
        title
        body
        url
        createdAt
        author {
          login
        }
        category {
          name
        }
        comments(first: 50) {
          nodes {
            author {
              login
            }
            createdAt
            body
          }
        }
      }
    }
  }
}
"""

def fetch_all_discussions():
    discussions = []
    cursor = None
    headers = {
        "Authorization": f"bearer {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "Heretek-Discussions-Archive"
    }

    while True:
        payload = {"query": QUERY, "variables": {"cursor": cursor}}
        req = urllib.request.Request(
            "https://api.github.com/graphql",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        
        repo_data = data.get("data", {}).get("repository", {})
        disc_conn = repo_data.get("discussions", {})
        nodes = disc_conn.get("nodes", [])
        discussions.extend(nodes)
        
        page_info = disc_conn.get("pageInfo", {})
        if page_info.get("hasNextPage"):
            cursor = page_info.get("endCursor")
        else:
            break

    discussions.sort(key=lambda d: d["number"])
    return discussions

def main():
    print("Fetching upstream discussions via GraphQL...")
    discussions = fetch_all_discussions()
    print(f"Fetched {len(discussions)} discussions. Writing archive to {OUTPUT_FILE}...")

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write("# Upstream GitHub Discussions Archive\n\n")
        f.write("> **Notice**: This document preserves historical GitHub Discussions from [`awesome-opencode/awesome-opencode`](https://github.com/awesome-opencode/awesome-opencode/discussions) as part of the hard fork by Heretek-AI.\n\n")
        f.write(f"Total Discussions Archived: **{len(discussions)}**\n\n---\n\n")

        for d in discussions:
            num = d["number"]
            title = d["title"]
            author = d["author"]["login"] if d.get("author") else "ghost"
            created_at = d["createdAt"]
            category = d.get("category", {}).get("name", "General")
            url = d["url"]
            body = d.get("body") or "*No content provided.*"
            comments = d.get("comments", {}).get("nodes", [])

            f.write(f"## Discussion #{num}: {title}\n\n")
            f.write(f"- **Original URL**: [{url}]({url})\n")
            f.write(f"- **Author**: [@{author}](https://github.com/{author})\n")
            f.write(f"- **Created At**: `{created_at}`\n")
            f.write(f"- **Category**: `{category}`\n\n")
            f.write("### Post Content\n\n")
            f.write(f"{body}\n\n")

            if comments:
                f.write(f"### Comments ({len(comments)})\n\n")
                for c in comments:
                    c_author = c["author"]["login"] if c.get("author") else "ghost"
                    c_created = c["createdAt"]
                    c_body = c.get("body") or ""
                    f.write(f"#### [@{c_author}](https://github.com/{c_author}) commented on `{c_created}`:\n\n")
                    f.write(f"{c_body}\n\n")

            f.write("---\n\n")

    print(f"Successfully archived {len(discussions)} discussions to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
