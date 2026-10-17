# Self-hosted TypeScript + SQLite behind Cloudflare Tunnel

The app runs as a single TypeScript (Node/Bun) process with a SQLite file, on the owner's local server. It is reachable through a Cloudflare Tunnel on a domain the owner holds. Live updates go out to clients over Server-Sent Events. The owner wanted to host it themselves. Supabase's free projects also pause after 7 days with no use, which is a bad fit for an app used only during trips. Firebase's document model makes balance math harder than SQL does. Google sign-in needs HTTPS on a real domain, and brand verification needs that domain verified in Search Console, which is why we use a tunnel on an owned domain rather than a raw IP or a *.ts.net URL ([research](../research/fx-rates-and-google-auth.md)).

## Consequences

- Availability depends on the home server and the tunnel. Backing up means copying one SQLite file.
- A single process keeps SSE fan-out in memory; scaling past one process would need a pub/sub layer.
