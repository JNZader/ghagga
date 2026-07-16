---
"ghagga": patch
---

`ghagga triage <iid> --reproduce` now wires live-app login credentials into the REPRODUCE harness, sourced from `GHAGGA_TRIAGE_LOGIN_EMAIL` / `GHAGGA_TRIAGE_LOGIN_PASSWORD` environment variables (so the password stays out of the config file, referenced via the `{{password}}` placeholder in the loginRecipe steps). Without this, a steps-based loginRecipe filled an empty password and login always failed.
