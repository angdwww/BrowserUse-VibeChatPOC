# Privacy Checklist

This repository is intended to be safe for a private GitHub proof-of-concept repo. Before making it public or sharing it with anyone, repeat this checklist.

## Files that should not be committed

The `.gitignore` excludes:

- dependency folders
- local environment files
- generated screenshots
- smoke/debug screenshots
- temporary VibeChat patch scripts
- test reports
- local editor settings

## Manual review before pushing

Check what will be committed:

```bash
git status --short
git diff --cached --stat
git diff --cached
```

Check tracked files:

```bash
git ls-files | sort
```

Search for obvious private data patterns:

```bash
git grep -nE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}"
```

Expected public project link:

```text
https://github.com/angdwww/VibeChat
```

That link is intentionally included because this project is a VibeChat proof of concept.

## Notes

- The app should not require API keys.
- The repo should not include browser profiles, cookies, generated screenshots, or local machine state.
- Keep the repository private unless it is intentionally cleaned and relicensed for public release.
