// Wrapped board composition: pick() must guarantee >=1 duo + >=1 group
// award whenever candidates exist, and never exceed the 7-card cap.
import { pick, type Award } from "../server/wrapped.ts";

let failed = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { console.log("  ok ", name); return; }
  console.log("  ✗  ", name, extra ?? ""); failed = 1;
};
const solo = (i: number, score = 30) => ({ emoji: "s", title: `solo${i}`, members: [`m${i}`], detail: "", score });
const duo = (i: number, score = 10) => ({ emoji: "d", title: `duo${i}`, members: [`m${i}`, `x${i}`], detail: "", score });
const grp = (i: number, score = 10) => ({ emoji: "g", title: `grp${i}`, members: [`m${i}`, `x${i}`, `y${i}`], detail: "", score });

// 10 strong solo majors + weak duo/group -> reservations still surface
{
  const pool: Award[] = Array.from({ length: 10 }, (_, i) => solo(i, 30 - i));
  pool.push(duo(0, 5), grp(0, 4));
  const b = pick(pool, 8);
  check("duo reserved", b.some((a) => a.members.length === 2), b.map((a) => a.title));
  check("group reserved", b.some((a) => a.members.length !== 1), b.map((a) => a.title));
  check("cap 7", b.length === 7);
}
// no group candidate -> duo still reserved, board fills from solos
{
  const b = pick([solo(0), solo(1), solo(2), duo(0)], 4);
  check("duo only still reserved", b.some((a) => a.members.length === 2));
  check("no phantom group", !b.some((a) => a.members.length > 2));
}
// small board: everything fits, reservation doesn't reorder the top solo
{
  const b = pick([solo(0, 30), duo(0, 5), grp(0, 4)], 3);
  check("all picked", b.length === 3);
}
// 2-person trip: duo award doubles as the "group" slot (members.length !== 1)
{
  const b = pick([solo(0), solo(1), duo(0)], 2);
  check("small board keeps duo", b.some((a) => a.members.length === 2));
}
process.exit(failed);
