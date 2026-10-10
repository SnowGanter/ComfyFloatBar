# Public edition validation

Checked on 10 October 2026.

- 55 Node unit tests passed.
- 6 Python worker tests passed.
- Default private-network addresses replaced with localhost.
- Shared hub data, logs, backups, test output, dependencies and model-preview artwork excluded.
- Optional LoRA preview handling checked by the catalogue test.
- Documentation screenshot shows the toolbar layout, rendered as a static preview.

This pass did not run live GPU generation, licensed Photoshop/Topaz operations or Windows installer packaging. These require an owner's configured desktop environment. Development-tool dependencies still have npm audit findings; this is a portfolio source edition, not a security-certified release.
