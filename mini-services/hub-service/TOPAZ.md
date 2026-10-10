# Topaz processor

The Hub machine runs a single persistent Topaz queue. Images are stored in
`download/HubFiles/TopazQueue`; unfinished jobs are marked interrupted after a
restart and are never resent automatically.

The default configuration matches this workstation: Gigapixel 8.3.x, Python
3.14, local ComfyUI and Telegram Saved Messages for account `Ilya`. To override
it, copy `topaz-config.example.json` to
`download/HubFiles/topaz-config.json`, edit the paths and restart ComfyFloatBar.

Install the processor dependencies into the configured Python with:

`python -m pip install -r topaz-requirements.txt`

Keep the Windows session unlocked during processing. The worker verifies the
foreground window before every UI action and pauses the whole queue after an
ambiguous UI or export failure. Only `cs2.exe` is in the forced-close allowlist.
