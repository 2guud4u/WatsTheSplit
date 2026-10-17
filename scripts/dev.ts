// Runs the API (bun --watch) and the Vite dev server together; Ctrl-C kills both.
const procs = [
  Bun.spawn(["bun", "--watch", "server/index.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bunx", "vite"], { stdout: "inherit", stderr: "inherit" }),
];

const stop = () => { for (const p of procs) try { p.kill(); } catch {} };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

// Exit if either child dies so a crash doesn't leave a silent half-running dev setup.
const codes = await Promise.race(procs.map((p) => p.exited));
stop();
process.exit(codes);
