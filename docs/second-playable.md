# Wizard RTS — Second Playable

*The first playable proved the loop: fly, burn, claim, march, race for the points. It works, and an unattended match ends in about 21 minutes. What it does not yet have is a **map game** — every city is identical, every army is identical, and the only decision a city ever makes is "army or shrine".*

*This document is the next milestone, and it is scoped to one thing: **strategic depth in the economy and the siege**. It realizes §3.1–3.5 of [`wizard-rts-full-design-doc.md`](wizard-rts-full-design-doc.md) — city tiers, buildings, connection resources, caravans, and trebuchets. Where this doc and the full doc disagree, this one wins for the second playable. Where this doc and [`first-playable.md`](first-playable.md) disagree, this one supersedes it.*

*Grounding: every art key named here is a real entry in `src/assets/sprites.ts` or `src/assets/units.ts`, checked before it was written down. Every number was checked against the code it will land in.*

---

## 1. What the second playable adds

Three systems, and they interlock on purpose:

1. **Cities become different from each other.** Three tiers, four buildings, a build menu that opens up as a city grows. A city is now a thing you invest in rather than a thing you own.
2. **The map has resources worth connecting to.** Six resource nodes that buff *the city that links them*, not a stockpile. Linking costs a caravan, and the caravan is a fragile thing walking a long road.
3. **Forts can be too strong to storm, and siege is the answer.** A forted city beats one ordinary army. Cracking it needs a trebuchet, which is slow, visible, and killable — so a siege train announces itself and invites a response.

The identity sentence gains a clause:

> **Armies destroy defenses. Caravans claim nodes. The wizard claims everything else.**

*Superseded by the fourth playable.* Consecration became the single claiming verb for everything that can be held, nodes included, and the caravan's job was narrowed to the one it was always really doing: **naming which city a node supplies**. See `fourth-playable.md` §1.

Target match length: **30–40 minutes**, up from 20–30. The extra time is build-up, not grind — the tier ladder and the siege arms race are what fill it.

### A correction carried in from the first playable

`first-playable.md` §5 says a standard six-unit army measures "~5700" by Lanchester power, and sizes every garrison as a multiple of that. Measured against the shipped `ARCHETYPE` numbers, a standard army is **8,840** (260 HP × 34 DPS — the bearer contributes nothing, correctly). The garrisons in `factions.ts` are therefore *easier* relative to an army than the old doc claims. The gameplay is fine — matches play well and that is the evidence that counts — but the labels were wrong, so here they are, honestly:

| Garrison | Power | In armies |
|---|---|---|
| Mine | 1,330 | 0.15 |
| Town | 3,080 | **0.35** |
| Resource node *(new)* | 4,680 | **0.53** |
| Lair | 7,130 | 0.81 |
| Point of Power | 10,675 | 1.21 |
| Central point | 21,995 | 2.49 |

Nothing in the tables changes. The comment in `factions.ts` and the appendix in the old doc do.

---

## 2. Cities: three tiers

**Village → Town → City.** Tiering up is a queue item like anything else — it costs gold and it costs the queue, which is the only real currency a city has.

**Tier gates the build menu.** That is the whole point of tiers: they open doors rather than adding a quiet percentage.

| | Village (T1) | Town (T2) | City (T3) |
|---|---|---|---|
| Build menu | Train Army, Shrine, Tier Up | + Fort, Market, **Caravan** | + Siege Works |
| Income | 10 g/min | 15 g/min | 20 g/min |
| Tier-up cost | 200 g / 90 s | 400 g / 120 s | — |

- **Each wizard's capital starts at Town.** A 90-second toll on the first minute of the match would be a bad opening for everyone, and the opening is the part of the first playable that already works.
- **Captured neutral towns arrive as Villages.** Expansion gives you a foothold, not a factory. Growing it is the investment.
- **A captured city keeps its tier and its surviving buildings** (full doc §3.5, confirmed). Taking a developed enemy city is the biggest prize on the map, which is exactly the incentive a war should have.
- **No per-tier army stat baseline.** The full doc gives tiers "raises army quality baseline"; that is deferred until special units exist. Army quality comes from connection resources instead, so the two systems don't stack invisibly and each one can be tuned by looking at it.

Buildings are drawn as cards around the pad edge, the same way fort towers already are, so **a city visibly accretes**. The tier readout is the skyline, not a number in a panel.

---

## 3. Buildings

| Building | Tier | Cost | Time | Effect | Art |
|---|---|---|---|---|---|
| **Shrine** | 1 | 100 g | 60 s | +1 mana regen/s (unchanged) | `mod.shrine1` |
| **Fort** | 2 | 150 g | 90 s | Two towers, **300 HP / 12 DPS / 30 m** | `mod.tower` |
| **Market** | 2 | 150 g | 75 s | **+10 g/min** at this city | `misc.tradingPost` |
| **Siege Works** | 3 | 250 g | 90 s | Unlocks the Trebuchet queue item | `mod.fort` |

Each is a one-time construction, and none of them can be built twice.

### Why the fort got stronger

This is the keystone number of the milestone, and the whole siege system hangs off it.

- One army = **8,840**.
- The old fort — 2 towers at 200 HP / 10 DPS — measures 400 × 20 = **8,000**. Slightly *weaker* than one army. A fort that one ordinary army walks through is a fort nobody needs siege for, and siege would have been a solution with no problem.
- The new fort — 2 towers at 300 HP / 12 DPS — measures 600 × 24 = **14,400 ≈ 1.6 armies**.

So: **one un-sieged army fails against a forted city.** Two armies win it, expensively. One army with a trebuchet cracks it cleanly, because the trebuchet outranges the towers and the towers cannot shoot back. That is three distinct strategies with three distinct prices, from one number.

### Market versus mine

A Market is +10 g/min for 150 g — safe, buildable anywhere, no garrison to fight. A gold mine is +15 g/min but has to be cleared and then held. The Market is the safe pick you can always take; the mine is the contested pick that pays more. Neither obsoletes the other, and no new tuning was needed to get there.

---

## 4. Repair, and what a losing attack is worth

The full doc (§4.5) proposes that city repair occupies the production queue, so that attacks too weak to win still cost the defender something. That resolves here:

- When a city's fort towers are damaged or destroyed **and its queue is empty**, a **Repair** item auto-queues itself: free, and it restores both towers to full in **45 s**. This replaces the free 60-second tower rebuild the first playable ran silently in the background.
- **Repair is the only queue item that yields.** Everything else, once commissioned, is committed. Order anything and the repair is dropped.

The result is a real decision under pressure rather than a rule to memorize: a raid that cannot take your city still forces you to choose between fixing your walls and building anything at all. And because 45 seconds is far shorter than the several minutes an army needs to reconstitute and march back, **chip damage always heals between waves** — which is precisely why a trebuchet is the only way one city cracks another.

---

## 5. Connection resources

Confirmed by the full doc (§3.3): map resources **buff the city that connects them** rather than filling a stockpile. One city per node; a city may hold any number of nodes; connecting requires a caravan; distance makes far connections expensive in time.

**Six nodes on the map, two of each kind:**

| Node | Buff on the connected city | Art |
|---|---|---|
| **Mithril Mine** | This city's army units deal **+30% damage** | `vein.ore` → `mine.orePit` when linked |
| **Wild Horse Plains** | This city's armies march **+30%** (4 → 5.2 m/s) | `misc.stables` |
| **Granary** | Reconstitution here costs and takes **×0.6** | `mine.windMill` |

Three buffs that answer three different questions — *hit harder*, *get there sooner*, *come back cheaper* — so which city links which node is a genuine choice. Mithril belongs on the city whose army does the fighting; a Granary belongs on the one that keeps losing it.

- **Buffs are binary**: on while the link is live, off the instant it isn't. No scaling with distance or throughput (confirmed placeholder resolved).
- **Different buffs stack** on one city. Duplicates of the same kind do nothing, which the doc says out loud and the code does not bother to forbid.
- Nodes are **guarded at ~0.53 armies** — treant, satyr and druid from the unused Great Elf roster, so "wild" keeps reading as wild. Cleared nodes regenerate on the standard 5-minute rule if nobody links them.
- **A node cannot be consecrated.** The wizard has no business here; the caravan's *arrival* is what claims it. This is the one place the milestone extends the identity sentence, and it earns it — it gives the caravan a job that no other system can do.
  - *Reversed by the fourth playable.* A node is consecrated like every other held site, and the caravan assigns rather than claims. The clause cost two standing special cases to prop up — "an AI must never treat a node as claimable", and an escape hatch for armies camped forever on ground nobody could claim — and both are now deleted rather than maintained.

---

## 6. Caravans

A **Caravan** is a queue item costing **50 g**, available from Town. The player commissions it and then picks the destination node with exactly the grammar armies already use: the button arms a pick, the next map click resolves to the nearest *known* node.

**The queue is held from commission until the wagon reaches the node** — 30 s to build, then travel at **3 m/s**. A 300 m route is about 130 seconds of held queue, which is more than two army trainings. That single rule is the entire cost model: far nodes are expensive, near nodes are cheap, and nothing needed a distance formula to say so.

On arrival the link goes live, the node takes the owner's colour, and the queue frees. The wagon then **circulates forever** between city and node as a visible `pickup.wagon` card — the convoy is the proof that the link exists.

**The wagon has 60 HP and no weapon.** Anything hostile kills it in seconds. When it dies the link severs instantly: the buff drops, the node reverts to unowned, its garrison starts growing back, and re-establishing costs the full queue time again. This also handles "an enemy occupying the node severs the link" without a special rule — an enemy camped on a node simply kills the wagon on its next lap.

Caravans path in a straight line like everything else. The first playable accepted that for armies on the grounds that the island's passes are wide; the same reasoning applies here, and the same promise holds — fix it only if it actually looks broken.

---

## 7. Siege

A **Trebuchet** costs **200 g / 90 s**, requires a Siege Works, and requires that city's army to be **home and idle** — you are attaching an engine to a specific body of troops, so the troops have to be standing there. On completion it joins that army as a seventh unit. The formation already has nine slots, which is the full doc's max-size army waiting to be used.

| | |
|---|---|
| HP | **80** — one fast unit kills it in about ten seconds |
| Damage | **40 DPS, structures only** — it cannot hit a unit at all |
| Range | **55 m** |
| Cost to the army | Marches at **×0.6** (2.4 m/s) while the trebuchet lives |
| Reconstitution | **Never rebuilt.** Lose it and you queue another at a Siege Works |

Why these numbers produce the beat the full doc asks for:

- **It out-damages repair by roughly six to one.** 300 HP ÷ 40 DPS = 7.5 seconds per tower, against a 45-second full restore. Siege is the only thing on the map that wins the repair race, which is what makes it the answer to a fort rather than a nice-to-have.
- **55 m beats the tower's 30 m.** The trebuchet stands outside the fort's reach and dismantles it. The defender cannot answer from behind the walls — they have to **sally, or watch the fort come down**. That is §3.5's "compels the opponent to respond with an army", arrived at from the geometry rather than asserted.
- **And the sally works.** 80 HP means the defender who does come out wins the exchange. The siege train is strong and slow and fragile, all at once, which is the only version of siege that creates a fight instead of ending one.

Siege damages **towers only** in this milestone. Cracking the fort is the strategic payload; disabling individual buildings needs per-building HP and a disabled state, and it can wait.

There is no siege art in either atlas — nothing in the sprite pack, no catapult creature in the unit pack. The trebuchet is therefore **generated geometry**, an A-frame and an arm, following the precedent already set by `src/render/banners.ts`: when the sim needs to show something the art doesn't have, the renderer builds it out of primitives rather than the design being cut.

---

## 8. AI

The AI plays by identical rules, as before — no vision cheat, no economy cheat, the same public commands the HUD calls. Three additions, and the third is the one the player will actually notice:

1. **Climb the tier ladder.** Keep the queue busy; tier up when gold allows; build Market and Shrine at home, Siege Works at the capital.
2. **Link what it clears.** When one of its armies clears a resource node, the nearest Town-or-better city with a free queue commissions a caravan to it.
3. **Bring siege to a forted city.** The AI will not throw armies at a fort it cannot crack: an enemy city with living towers is skipped as a target unless the army carries a trebuchet. When it wants one, it queues a Siege Works and then a trebuchet, and *then* marches. (The one override is the existing endgame panic — once any wizard passes 60% charge, everything goes at that wizard's points regardless.)

That third rule is what makes the whole milestone legible from the player's chair: sooner or later a slow column with an engine in it comes over the hill toward your walls, and you have to decide whether to fly out and burn it.

---

## 9. Explicitly deferred

| Cut | Why safe |
|---|---|
| **Roads wearing in, and the road speed bonus** | The only part of §3.4 that needs new *infrastructure* rather than new rules: a traffic heat grid, terrain writes driven by the sim (which owns no render state, on purpose), and path-following that doesn't exist. It's a buff plus a visual, and it changes no decision the caravan's route exposure doesn't already create. The circulating wagon is the road for now. |
| **Tier-3 capstone** (Champion's Hall / High Aerie) | Needs special units and retinue, both already deferred. |
| **War Camp, and a second army per city** | Cut on review, and worth writing down why. One army per city is load-bearing rather than incidental: the army roster is effectively a list of the cities you hold, and a second army bought with gold at an existing, safe city is *more army without more map*. Fielding more troops is supposed to mean expansion — taking another town, which is contested, visible, and what the entire opening is built on. An upgrade that sidesteps that is a worse version of the decision it replaces. Tier 3 unlocks Siege Works alone, and that is enough: it gates the only answer to a fort. |
| **A second city currency** | Full doc §3.2 confirms exactly two currencies and confirms mana is the wizard's, not the city's. Cities stay gold-only. Written down here so nobody "finishes" this later. |
| **Market gating caravan range** | Couples two new systems on their first day. Distance already prices caravans through the held queue. |
| **Ley Spring, Ironwood Grove, Monster Graveyard** | Each rides a system that is deferred or brand new. Three node kinds is the minimum that makes "which node do I want" a real question. |
| **Siege damaging buildings other than towers** | Needs per-building HP and a disabled state. |
| **Peon theater on caravans and repair gangs** | Still pure dressing. The wagon carries the fantasy by itself. |
| Skiing, further spells, artifacts, heroes, retinue, multiplayer | Unchanged from `first-playable.md` §8. |

---

## 10. Build order — **all seven steps built** (step 7 in the third playable)

Each step is playable on its own and typechecks on its own (`npm run typecheck`, the same check CI runs).

0. **This document.**
1. **Split `sim.ts` before adding to it** — `rules.ts` (the numbers) and `ai.ts` (the AI loop) come out; no behavior changes. The file is 1,574 lines and this milestone adds several hundred more; the split is cheapest now, while it is a pure move.
2. **Tiers** — `tier` on a site, the build menu derived from it, income by tier, tier preserved on capture, AI climbs the ladder.
3. **Market, the fort rebalance, and the repair queue** — the keystone balance step. *Test: one army must fail against a forted city and the fort must be whole 45 s later; two armies must win.*
4. **Resource nodes on the map** — placement, garrison, and the rule that the wizard cannot claim them.
5. **Caravans, links, and the three buffs** — the largest step. *Test: link a Mithril mine and watch the same army win a fight it previously lost; then kill the wagon and watch the buff drop.*
6. **Siege Works and the trebuchet** — including the AI that brings one. *Test: an AI siege train cracks a player fort; a sally that kills the trebuchet defeats the assault.*
7. **Tuning pass and doc sync** — unattended matches, retune `rules.ts`, mirror the final numbers back into §11 here. *Done as part of [`third-playable.md`](third-playable.md), which built the harness it needed; see the note below and §11.*

### What the build actually cost

Steps 2–6 landed with one balance surprise and three real bugs, all three of them in code the first playable had shipped happily — because nothing until now had asked an army to attack a *fortified* pad.

**The fort did not work at all, and it had never been asked to.** Three separate rules had to change before the 1.6-armies number on paper meant anything on the ground:

1. **The chase leash was shorter than the fort was wide.** A city's towers stand at 0.55 of a 48-unit pad — 26 units out — so a swordsman needed to reach 24 units from its army's anchor, and the 22-unit leash stopped it two short. *Every time.* Only the archer could answer, one bow against two towers, while five soldiers stood in range being shot and physically unable to close. An army now fights anywhere on the pad it is standing on: the leash is a rule about **travelling**, not about the battle it came to have.
2. **Looking and reaching were separate numbers, and a fort sits on the seam.** Units notice enemies at 32 and the widened leash reaches 43, so whether a soldier engaged the *second* tower came down to which formation slot it happened to be standing in. Two armies took one tower and then stood beside the other for four minutes without ever seeing it. A unit now looks at least as far as it may go.
3. **A besieged city rebuilt its walls with the enemy in the courtyard.** Repair re-raised the towers every forty-five seconds for as long as the siege lasted, so an army that had already won had to keep winning, and an assault whose wizard was dead or elsewhere could never resolve. A contested city does not repair.

With those three fixed, the keystone test reads exactly as §3 claims: **one army fails; two armies crack it and lose four of ten; one army with a trebuchet cracks it and loses nobody.**

### The open question for step 7 — **answered in the third playable, and the guess was wrong**

A full unattended three-wizard match runs end to end and produces a winner. But on a synthetic board it finished in **19 minutes with no wizard ever reaching tier 3** — so no Siege Works was ever built, no trebuchet was ever fielded, and the centrepiece of this milestone never appeared in a match nobody was steering.

The mechanism is fine; the harness proves an engine cracks a fort as designed. What is wrong is the **pacing**: the AI's build ladder pays for an army, a shrine, a market and a fort at *every* city it takes before it tiers any of them up, so 400 gold for a City never comes free before the charge race is decided. Whichever way that is fixed — a cheaper tier 3, Siege Works pulled down to Town, or an AI that grows its capital instead of fortifying every village — it is a tuning decision that should be made against the **real generated island**, not against the flat test board that produced this number. That is step 7, and it wants a playtest rather than a harness.

> **What actually happened.** [`third-playable.md`](third-playable.md) built the harness this paragraph says it does not need — `npm run match`, on the real island — and the pacing story above turned out to be a symptom rather than the cause. On the generated board **two of the three wizards never built an army at all**, because the AI's build ladder was allowed to fall through to something cheaper when it could not afford the top of its list, and a caravan costs half what an army does. Four more compounding faults sat behind that one, none of them a price. The cheaper tier 3 *was* eventually adopted — 400 g → 300 g — but as the last small step of a fix, not the fix. See `third-playable.md` §1.
>
> The lesson worth carrying forward is the one this section is an example of: **a claim about an unattended match is not evidence unless something ran the match.** The numbers above came from a harness that was thrown away, on a board the game does not generate.

### Bugs not to introduce (the successors to `first-playable.md` §9's four)

1. **An AI must never treat a resource node as claimable.** `canConvert` rejects nodes, but the AI's *claim-target* filter has to reject them too — otherwise an AI wizard flies to a cleared node and hovers there forever. This is exactly the shape of first-playable trap #3.
2. **`markHotSites` must wake garrisons for caravan wagons**, not just for wizards and army anchors. Otherwise every garrison along a route sleeps through the traffic and caravans are unkillable in practice.
3. **The rout rule must count the trebuchet as a non-combatant.** A bearer and a trebuchet alone must rout, or a dead army's siege engine marches on by itself.
4. **Reconstitution must neither price, rebuild, nor retire the trebuchet** — including `trainArmy`'s leftover-retire loop, which kills units the new roster doesn't want.
5. **The march buff must scale the anchor *and* the individual unit speed.** Buff one and not the other and the army permanently trails its own formation marker.
6. **Capture severs the old owner's caravans and drops any queued repair**, while keeping tier and buildings — all of it inside `claim()`, the single place ownership changes.
7. **A unit must never be able to walk further than it can see.** Aggro and leash are two numbers describing one thing, and any change that widens one has to widen the other or armies stall next to enemies they are standing on top of.
8. **Anything positioned by pad *radius* rather than by formation offset is out of an army's reach by default.** Towers were the first; a future gatehouse or wall segment will be the next.

---

## 11. Numbers appendix (additions to `first-playable.md` §10)

*Two of these moved in the third playable and are marked. `third-playable.md` §9 is the current appendix.*

| | |
|---|---|
| City tiers | Village → Town → City · capitals start Town · captured towns arrive Village |
| Tier-up | →Town 200 g / 90 s · →City ~~400~~ **300** g / 120 s *(third playable)* |
| City income | 10 / 15 / 20 g/min by tier · Market +10 g/min |
| Market · Siege Works | 150 g/75 s (Town) · 250 g/90 s (City) |
| Fort towers | 2 × 300 HP · 12 DPS · 30 m range (fort ≈ 1.6 armies) |
| Repair | free, auto-queued when the queue is empty, full restore in 45 s, yields to any order |
| Trebuchet | 200 g / 90 s · 80 HP · 40 DPS structures only · 55 m · army ×0.6 · never reconstituted |
| Caravan | 50 g · 30 s build then 3 m/s travel, queue held until arrival · wagon 60 HP, unarmed |
| Resource nodes | ~~6~~ **12** (2 each of six kinds) · garrison ≈ 0.53 armies *(third playable)* |
| Node buffs | +30% damage · +30% march · reconstitution ×0.6 |
| Standard army power | 8,840 (260 HP × 34 DPS) — the reference for every garrison multiple |
| Target match length | 30–40 min |
