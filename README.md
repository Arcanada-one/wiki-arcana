# Wiki Arcana server

Wiki Arcana is an open-source knowledge-space registry and API/MCP orchestration service for agents.

The initial release contains a relational space classifier, hierarchical authorization contracts, and engine-independent graph/vector ports. It intentionally contains no knowledge content, embeddings, graph engine activation, or local authentication.

## Development

```bash
corepack pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Configuration is documented in `docs/reference/configuration.md`. Deployment requires a protected branch, successful checks, a self-hosted runner, and verified database backup evidence for the production database.

## Security and authorization

Identity is supplied by an external OIDC provider. Clearance levels and capability scopes are resolved with server-side, deny-wins space grants. Caller bearer tokens are never forwarded to downstream services.

See `SECURITY.md` for reporting and `docs/reference/rbac-levels.md` for the access model.

## Branch protection checklist

- Require pull-request review and passing lint, typecheck, test, build, and security checks.
- Restrict direct updates and force pushes to the default branch.
- Run deployment only from a protected default-branch event on self-hosted infrastructure.
- Keep repository secrets out of forked pull-request jobs.

## License

MIT

