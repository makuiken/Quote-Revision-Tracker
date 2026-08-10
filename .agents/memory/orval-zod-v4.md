---
name: Orval zod v4 syntax
description: Codegen fix when orval emits zod.int() against zod 3.25 classic import
---
Orval v8 emits zod v4 syntax (e.g. `zod.int()`) but generates `import * as zod from 'zod'`, which resolves to the classic v3 API in zod 3.25 — codegen typecheck fails with TS2339 on `int`.

**Why:** zod 3.25 ships the v4 API only under the `zod/v4` subpath; the root export lacks `int()`.

**How to apply:** The codegen script in `lib/api-spec/package.json` seds the generated import to `zod/v4` after orval runs. Keep that step if the script is regenerated; any OpenAPI spec using `type: integer` triggers the issue.
