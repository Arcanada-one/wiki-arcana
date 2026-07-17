# Architecture

The server separates transport, authorization, space classification, and storage capabilities. REST and MCP use one authorization service; every retrieval-capable storage method requires an access context.

The relational registry is the source of truth for space hierarchy and grants. Graph and vector engines remain behind capability-specific ports.

REST and MCP share one loopback-bound NestJS/Fastify process in Phase 1. The MCP
module uses a fresh Streamable HTTP transport for every request, with session IDs
disabled and JSON response mode enabled. Extract MCP into its own deployable only
when its release cadence diverges from REST, streaming tool load starves the API
event loop, or it requires independent scaling.
