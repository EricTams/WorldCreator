# Untitled Wizard RTS — Full Design Document (Draft with Placeholders)

*This is the "filled-in" version of the design doc. Confirmed decisions appear unlabeled. Every detail invented to complete the document is prefixed with **TempPlaceholder:** — those items are proposals to react to, not decisions. If a whole section is new, it's noted at the top of the section, and its contents are still individually tagged.*

---

## 1. Concept

A real-time strategy game in which the player is a wizard who flies around the world casting magic spells and directing armies to defeat rival wizards.

**Tone and feel references:**

- **Magic Carpet** — flying around, manipulating the terrain, casting spells, gaining mana
- **Majesty / Heroes of Might & Magic / Warlords Battlecry / Master of Magic** — claiming cities, clearing out neutral enemies, claiming resources and resource production, sending armies to attack
- **Populous / PowerMonger** — independent peons that respond to your manipulation

**Core loop:**

1. Claim cities
2. Upgrade cities, rally units from the cities
3. Attack neutral sites to get rewards/resources or a resource generator
4. Slowly expand until you are powerful
5. Upgrade your magic and your armies
6. Attack the enemy magicians

**Design identity:** the wizard is the only thing the player directly controls. Cities, armies, and caravans are autonomous once given orders. The player's physical position on the map is a core strategic resource. Armies destroy defenses; the wizard claims.

**TempPlaceholder:** Working title: *Dominion of the Five* (from the five Points of Power).

**TempPlaceholder:** Player count: 1v1 through 4-player free-for-all, plus a single-player skirmish mode against AI wizards. All modes use the same 5-point victory condition.

---

## 2. The Wizard

### 2.1 Flight (Tribes-style "skiing")

- A **boost** key (shift) gives a short-term speed burst; boost recharges up to **3 charges**.
- Boosting while going **downhill** grants extra speed that **does not bleed off until you turn**.
- Movement has **acceleration**, so flight feels weighted rather than instant.

**TempPlaceholder:** Base cruise speed crosses a standard map edge-to-edge in ~90 seconds. A well-skied route does it in ~55 seconds (max sustained skiing ≈ 1.7× base). Armies march the same distance in ~6 minutes on roads, ~9 off-road.

**TempPlaceholder:** Boost charge recharge time: 8 seconds per charge. A boost lasts ~1.5 seconds and roughly doubles current speed while active.

**TempPlaceholder:** Turn threshold for momentum bleed: heading changes under ~15°/second preserve skied speed; sharper turns bleed it over ~2 seconds.

**TempPlaceholder:** Altitude is bounded: the wizard flies within a band above the terrain (roughly treetop to low-cloud). Diving trades altitude for speed like a downhill; climbing bleeds speed. There is no unlimited ceiling — anti-air threats can always reach the top of the band.

**TempPlaceholder:** Camera: third-person chase camera with a soft auto-zoom-out at high speed, plus a tactical zoom toggle that pulls to a near-top-down view for reading battles and issuing roster orders. Roster orders can be issued at any zoom.

### 2.2 Damage, healing, and respawn

- The wizard **can take damage**.
- A wizard who takes too much damage must **heal or respawn at a nearby city**.
- Castles and neutral sites have **defenses / ranged units that target the closest unit**.

**TempPlaceholder:** At 0 HP the wizard vanishes and **respawns at their nearest friendly city** after a 30-second timer. (An earlier two-stage Wounded → Banished proposal was rejected.)

**TempPlaceholder:** Passive regeneration: the wizard slowly heals anywhere inside friendly territory (near friendly cities/points), and quickly while landed at a friendly city. No healing in neutral/enemy territory except via spells or items.

**TempPlaceholder:** No loss of artifacts, spells, or progress on death. The penalty is time and geography only.

### 2.3 Mana

*(Section is TempPlaceholder in its details; the confirmed facts are that cities can generate mana/magic resources to power up the wizard, and spells have meaningful cooldowns.)*

**TempPlaceholder:** The wizard has a **mana pool** (bar) that fuels all casting. Base regeneration is slow everywhere; each city with a Shrine building adds a flat +regen; each held Point of Power adds a larger +regen. Maximum pool size grows with total Shrine count.

**TempPlaceholder:** Cooldowns and mana are separate throttles: cheap spells are limited mainly by mana; the big signature spells have long cooldowns (30–120 seconds) *and* large mana costs.

### 2.4 Spells

Confirmed structure: ~10 spells by endgame; anchors are **Conversion**, a **signature attack**, and a **signature utility**; remaining spells cover terrain shaping, unit buffs, enemy debuffs, structure creation, etc. Spells are powerful with meaningful cooldowns.

Spells are **unlocked through towns and loot** — found in the world, not purchased from a menu.

**TempPlaceholder:** Specifics: the wizard starts with 3 spells (Conversion, signature attack, signature utility). The remaining 7 come from claimed towns (certain towns hold a spell, granted on consecration) and from loot at cleared tier-3 sites. All 10 known spells are always available (no loadout subset), on the theory that cooldowns already ration usage.

**TempPlaceholder:** Example spell list (illustrative set of 10):

1. **Conversion / Consecrate** *(confirmed to exist)* — channeled ritual on a cleared city or Point of Power; claims it. **TempPlaceholder details:** 15-second channel, wizard is grounded and cannot move or cast; taking damage past a threshold interrupts it.
2. **Signature Attack — Meteor** *(slot confirmed; spell TempPlaceholder)* — long-cooldown AoE strike; cracks fortifications, devastates clustered units.
3. **Signature Utility — Windstep** *(slot confirmed; spell TempPlaceholder)* — instantly refills all boost charges and grants brief unturnable momentum; escape/chase tool.
4. **TempPlaceholder: Firebolt** — cheap, short-cooldown single-target damage; the "always something to do" spell.
5. **TempPlaceholder: Raise Ridge** — terrain shaping; lifts a line of ground. Blocks ground paths, creates ski slopes, shields against ranged fire.
6. **TempPlaceholder: Rally Banner** — buff; plants a standard that heals and hastens friendly units in a radius for 20 seconds.
7. **TempPlaceholder: Curse of Rust** — debuff; target enemy city repairs at half speed for 30 seconds (the repair-denial tool that pairs with sieges).
8. **TempPlaceholder: Summon Watchtower** — creates a temporary structure; a conjured tower that shoots at the nearest enemy for 60 seconds. Cheap scouting/route defense.
9. **TempPlaceholder: Earthmaw** — terrain attack; opens a fissure that swallows/slows a marching column. Anti-army, anti-caravan.
10. **TempPlaceholder: Veil** — utility; the wizard and retinue become untargetable by site defenses for 6 seconds (does not prevent enemy-wizard damage). Enables risky flyovers.

### 2.5 Artifacts and heroes

- The wizard can find **potent artifacts** in the world (example: a giant flaming sword).
- Artifacts are given to **army leaders** (flag bearers), turning them into **super-powerful hero units**.

**TempPlaceholder:** Artifacts drop from the toughest tier of neutral sites and are physical items the wizard carries (carrying more than one at a time is allowed). Delivering one to an army transforms its flag bearer into a hero on the spot.

**TempPlaceholder:** When a hero dies, the artifact drops on the ground where they fell and can be recovered by any wizard — including the enemy. Artifacts are never destroyed.

**TempPlaceholder:** There are 6 artifacts per match, fixed list, randomized locations. Examples: Flaming Greatsword (hero gains cleaving fire damage), Banner of the Unbroken (army's foot soldiers gain +50% HP), Horn of Haste (army marches 40% faster), Storm Quiver (ranged unit attacks pierce), Gorgon Shield (hero briefly petrifies attackers), Crown of the Wild (army's special unit is duplicated).

### 2.6 Retinue

- Maxing out a city grants **special retinue units** that fly with the wizard.
- The retinue stays **with the wizard** — no formation lag or separate positioning to manage.

**TempPlaceholder:** Each maxed (tier-3) city grants one retinue unit, cap of 3 flying with the wizard at once. Retinue units auto-attack what the wizard attacks and screen the wizard (they count as "closer" targets for defense targeting). When one dies, its home city automatically queues a replacement (60 seconds of queue time), and the replacement joins the wizard the next time the wizard passes near any friendly city.

**TempPlaceholder:** Retinue types depend on the granting city's specialization — e.g., Griffon Rider (martial city), Bound Elemental (shrine city), Sky Warden (trade city).

---

## 3. Cities & Economy

### 3.1 City structure and upgrades

Confirmed: cities build upgrades over time; upgrades are **chunky**; cities can support things like a fort, a patrolling army, stronger army composition, economy buildings, and siege equipment.

**TempPlaceholder:** Cities have **3 tiers** (Village → Town → City). Tiering up is itself a queue item with a currency cost. Each tier unlocks build options and raises army quality baseline.

**TempPlaceholder:** Each city has **one production queue**. Everything a city does — tier-ups, buildings, army training/reconstitution, caravans, siege construction, wall repair — occupies this single queue, one item at a time. The queue is the city's opportunity-cost currency.

**TempPlaceholder:** Building list (each is a one-time chunky construction):

- **Fort** — walls + defensive ranged emplacements (the "targets closest unit" defenses). Required before the city can repair through attacks at full rate.
- **War Camp** — adds a second army slot to the city (city supports two armies instead of one).
- **Shrine** — adds mana regeneration and max mana for the wizard.
- **Market** — increases gold income; required to send caravans beyond a short range.
- **Siege Works** — enables trebuchet construction.
- **Grand upgrade (tier 3 capstone, pick one):** *Champion's Hall* (armies from this city get +1 special unit and improved stats), or *High Aerie / equivalent* (grants the retinue unit).

### 3.2 Currencies

Confirmed: some resources are stockpiled currencies; resources unlock city upgrades.

**TempPlaceholder:** Exactly **two currencies**:

- **Gold** — generated passively by every city (more with Markets and trade). Spent on all queue items: buildings, tier-ups, armies, caravans, siege.
- **Mana** — the wizard's casting resource (see 2.3). Not spent by cities.

Everything else in the economy is expressed as connection buffs, not stockpiles.

### 3.3 Connection resources

Confirmed: map resources buff the connected city rather than filling a stockpile (mithril mine example — connected city's army does more damage). One city per resource; a city may connect to any number of resources; connecting requires sending a caravan; caravans cost production time rather than slots; distance makes far connections time-expensive.

**TempPlaceholder:** Connection buffs are **binary** (on while the link is intact, off otherwise) — no scaling with distance or throughput.

**TempPlaceholder:** Example resource node list:

- **Mithril Mine** *(confirmed example)* — connected city's army units deal increased damage.
- **TempPlaceholder: Ironwood Grove** — siege equipment from this city is cheaper and sturdier.
- **TempPlaceholder: Wild Horse Plains** — the city's fast unit is upgraded to heavy cavalry; armies march faster.
- **TempPlaceholder: Ley Spring** — the city's Shrine output is doubled.
- **TempPlaceholder: Granary Plains** — army reconstitution at this city is 30% faster.
- **TempPlaceholder: Monster Graveyard** — the city's special unit slot produces a monstrous unit.

**TempPlaceholder:** Buffs from multiple connections stack on one city. No hard cap; the soft cap is queue time and route exposure.

### 3.4 Caravans

Confirmed: a caravan establishes the connection; commissioning one occupies the city's production queue (blocking other upgrades); one city per resource; long routes are time-expensive.

**TempPlaceholder:** The queue is occupied from commission until the caravan **arrives at the node** (build time + travel time). After arrival the link is live and the queue frees up.

**TempPlaceholder:** The caravan then **circulates permanently** between city and node as a visible convoy of peons and wagons. The buff is active while the caravan lives and the node is unoccupied by enemies.

**TempPlaceholder:** If the caravan is killed, the buff drops and re-establishing costs the full queue time again. If the node itself is occupied or razed by an enemy army, the link is severed until the node is cleared/retaken.

**TempPlaceholder:** Roads: repeated caravan and army traffic wears visible roads into the terrain. Units move 30% faster on roads. Roads slowly fade if unused.

### 3.5 Siege equipment

Confirmed: cities can build siege equipment (trebuchets); a trebuchet threatening a castle compels the opponent to respond with an army or watch their castle get blasted.

**TempPlaceholder:** Trebuchets are built by a city with Siege Works (queue item), then attach to one of that city's armies as an extra unit. They are slow (army marches at 60% speed while escorting siege), fragile, and massively out-damage city repair.

**TempPlaceholder:** Siege damages **fortifications and buildings** — it can crack the Fort, breach walls, and disable buildings — but cannot raze a city to nothing. A fully breached city loses its repair advantage and defensive fire, opening it to capture. Captured cities keep their tier and surviving buildings.

---

## 4. Armies

### 4.1 Composition

- Default army: **3 foot soldiers, 1 ranged unit, 1 fast unit** (targets ranged units), and **1 flag bearer** who can become a hero.
- Combat is **physical**: units actually walk up and attack; positions and targeting play out on the map.
- City upgrades can improve stats or **add units** — generally a **special unit**.

**TempPlaceholder:** Flag bearer before hero transformation: non-combatant; provides a small morale aura (+10% attack speed to the army). If the flag bearer is the last unit alive, the army routs home.

**TempPlaceholder:** Special unit examples (granted by capstone/connections): Knight-Captain (heavy melee), Ballista Crew (long-range anti-fort), Beast (monstrous bruiser from Monster Graveyard), War Priest (slowly heals the army between fights).

**TempPlaceholder:** Maximum army size with all upgrades: 9 units (6 base + special + one duplicate special via artifact + trebuchet).

### 4.2 Creation and command

- **No micromanagement.** An army is given a target from its city; training time scales with how injured the army is; once ready, it walks to the target.
- Armies have **one job**: go to a location and **eliminate the defenses there**. No reinforce order.
- **Armies destroy defenses; the wizard claims.**

**TempPlaceholder:** Mid-march control: an army can be **retargeted** to a different location or **recalled** home at any time (it re-paths from where it stands). No finer control exists.

**TempPlaceholder:** Targeting requires the location to have been **discovered** (seen at least once by the wizard, a friendly unit, or a caravan). Intel can be stale; the threshold system punishes ignorant attacks.

**TempPlaceholder:** After eliminating a site's defenses, the army **camps at the cleared site** and behaves as if idle there (defends the clearing, sallies at approaching enemies) until the wizard consecrates the site or the army is retargeted/recalled. On consecration, the army automatically marches home.

### 4.3 Army selector UI

- Panel on the side of the screen, **sorted by distance to the wizard**.
- Each entry shows the army's **home city**, **current activity**, **health**, etc.
- Click an army, then set its attack target — from anywhere.

**TempPlaceholder:** Entry contents: home city crest, composition pips (one per living unit, special units iconized, hero banner if present), status verb (Defending / Marching / Fighting / Camped / Reconstituting + progress), and strength bar. Entries flash when the army takes damage.

**TempPlaceholder:** List reorder damping: the list re-sorts at most once every 3 seconds to prevent entries shifting under the cursor mid-click.

### 4.4 Default defensive behavior

- Any **idle army defends its home city** and **sallies forth to engage attackers**.

**TempPlaceholder:** Sally leash: defenders pursue up to ~1.5× the city's defensive-fire radius, then break off and return. Camped armies at cleared sites use the same leash around the site.

### 4.5 Combat resolution (thresholds and attrition)

- **Neutral sites:** a too-weak army is decimated but keeps attacking; e.g., a level 1 army might take 3 tries to clear a level 2 site.
- **Player cities:** attacks can be futile — a city can repair faster than a weak army damages it. Siege exists to overcome this.

**TempPlaceholder:** Neutral sites regenerate slowly (fully healing over ~5 minutes), so consecutive waves benefit from prior attrition but old chip damage fades.

**TempPlaceholder:** City repair occupies the city's production queue — repairing through an attack means the city builds nothing else meanwhile. Sub-threshold attacks therefore function as economic suppression even though they can't win.

**TempPlaceholder:** Launch-time forecast: when targeting, the UI shows a relative-strength indicator (comfortable / costly / grinding / futile) based on known intel, Warlords-style.

---

## 5. Neutral Sites

*(Entire section is TempPlaceholder; confirmed facts are only that neutral sites exist, have defenses that target the closest unit, and yield rewards/resources or resource generators.)*

**TempPlaceholder:** Site tiers:

- **Tier 1 — Camps** (bandits, wolves): melee-only defenders. Safely soloable by the wizard from the air. Reward: gold cache.
- **Tier 2 — Holds** (watchtowers, orc forts): include ranged defenders. Require an army screen or clever terrain. Reward: large gold cache or they sit adjacent to resource nodes as their guardians.
- **Tier 3 — Lairs** (harpy roosts, storm spires, dragon caves): include **anti-air** threats that pursue into the sky. Demand combined arms. Reward: artifacts and spells.
- **Neutral towns:** unaligned cities that can be cleared and consecrated into your kingdom — the primary expansion mechanism.

**TempPlaceholder:** Site defenders use the same unit vocabulary as armies (melee / ranged / fast / flying), so player knowledge transfers between PvE and PvP.

---

## 6. Peons & Population

*(Entire section is TempPlaceholder; confirmed facts are only the Populous-style tone reference and that peons appear in caravans/repair contexts.)*

**TempPlaceholder:** Population is **theater, not a resource**. Peons are visual bodies that represent what the city's queue is doing: builders swarm a construction site, wagon crews walk caravan routes, repair gangs patch walls under siege. Killing peons does not damage a separate population stockpile — but killing the *caravan* peons drops the link, and wizard AoE that hits repair gangs briefly pauses repair. There is no food, housing, or population growth mechanic.

---

## 7. Map Structure

*(Entire section is TempPlaceholder; confirmed facts are only that there are 5 Points of Power and that terrain matters for skiing.)*

**TempPlaceholder:** Standard skirmish map: one continent, no water barriers. Per player: 1 starting city + 3–4 nearby neutral towns in a loose "homeland" region. Center and midlands: contested neutral towns, resource nodes, and tier-2/3 sites.

**TempPlaceholder:** Points of Power placement: 1 per player placed toward each homeland's frontier (contestable but defensible), remainder in the dangerous center guarded by tier-3 sites. On a 2-player map: 2 frontier points + 3 central.

**TempPlaceholder:** Terrain is real for armies (mountains block, passes channel marches) and is ski infrastructure for the wizard (ridgelines and valleys form fast routes). Every major site has at least one interesting ski approach and one army-viable ground approach.

**TempPlaceholder:** Map counts (2-player standard): ~10–12 claimable towns, ~10 resource nodes, ~15 neutral sites, 5 Points of Power.

---

## 8. Victory

- **5 Points of Power** on the map.
- Each point held charges the holder **1% per minute** (example rate; tuning placeholder). Charging is additive by points held; progress persists.
- At **100%**, the player casts the **Spell of Mastery** and wins **instantly** — no ritual, no interruption window. The defense against a leader is denying them the points *before* they reach 100%.
- Players can prioritize capturing their own points or stealing them from opponents.

**TempPlaceholder:** Points of Power are cleared and consecrated exactly like cities (army eliminates defenses, wizard converts). They come with strong innate defenses that partially rebuild for whoever holds them.

**TempPlaceholder:** Each held point also grants a large mana-regeneration bonus, so point control powers the wizard directly as well as advancing the clock.

**TempPlaceholder:** All players' charge percentages are always visible on the main HUD.

---

## 9. Match Skeleton

*(Entire section is TempPlaceholder.)*

**TempPlaceholder:** Target match length: **35–50 minutes** (2-player).

- **Minutes 0–8 — Homeland:** clear tier-1 sites, consecrate 2–3 neutral towns, first caravans, first Fort.
- **Minutes 8–20 — Expansion:** tier-2 sites, resource competition begins, first frontier Point of Power taken, first wizard skirmishes over contested nodes.
- **Minutes 20–35 — War:** siege trains, raids on caravans and points, central tier-3 sites cracked for artifacts and spells, point ownership churns.
- **Minutes 35+ — Endgame:** someone approaches 100%; play collapses toward their points; final assaults race the leader's charge clock.

---

## 10. Open Items Even the Placeholders Don't Cover

- Faction/wizard differentiation (asymmetric spell schools? cosmetic only?)
- Fog of war rules in detail
- Audio/visual direction
- Difficulty and AI-wizard behavior for single-player
- Tutorialization of the no-micro command model
- All numeric tuning (every number above is provisional)
