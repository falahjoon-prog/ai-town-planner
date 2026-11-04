"""Publish the web app to a free Hugging Face Docker Space (<user>/town-planner).

Copies only what the Dockerfile needs into a staging folder, adds the Space README header,
and syncs it to the Space (files no longer present are deleted). Hugging Face then builds
and runs the image. Needs HF_TOKEN (a write token) in the environment.
"""
import os
import shutil
import subprocess
import tempfile

from huggingface_hub import HfApi

SPACE = "town-planner"
PATHS = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "index.html", "vite.config.ts",
         "tsconfig.json", "app-icon.png", "src", "public", "server", "src-tauri/src", "src-tauri/knowledge"]
HEADER = """---
title: AI Town Planner
emoji: 🏗️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 8080
pinned: true
short_description: Queensland site planning check on your phone
---

AI Town Planner web app (phone PWA). Source: https://github.com/falahjoon-prog/ai-town-planner
"""

api = HfApi(token=os.environ["HF_TOKEN"])
user = api.whoami()["name"]
repo = f"{user}/{SPACE}"
if not api.repo_exists(repo, repo_type="space"):
    # New accounts may be refused here (HTTP 402); then create the Space once on the website:
    # https://huggingface.co/new-space -> name "town-planner", SDK Docker, Blank, CPU basic (free).
    api.create_repo(repo, repo_type="space", space_sdk="docker")

stage = tempfile.mkdtemp()
files = subprocess.run(["git", "ls-files", "--", *PATHS], capture_output=True, text=True, check=True).stdout.split()
for f in files:
    dst = os.path.join(stage, f)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(f, dst)
with open(os.path.join(stage, "README.md"), "w", encoding="utf-8") as fh:
    fh.write(HEADER)

api.upload_folder(folder_path=stage, repo_id=repo, repo_type="space", delete_patterns="*",
                  commit_message=f"Deploy {os.environ.get('GITHUB_SHA', 'local')[:7]}")
url = f"https://{user.lower().replace('_', '-').replace('.', '-')}-{SPACE}.hf.space"
print(f"::notice title=Live (first build takes a few minutes)::{url}")
