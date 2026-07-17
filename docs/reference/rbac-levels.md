# Authorization levels

Clearance slugs are `public`, `archivist`, `council`, and `holocron`; their server-side ordinals are 0, 10, 20, and 30. Capability scopes are `wiki.read`, `wiki.write`, and `wiki.admin`.

Explicit denial wins over rank and explicit allowance. Fine-grained grants are resolved server-side and are not embedded in long-lived tokens.

