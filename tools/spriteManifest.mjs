/**
 * The curated slice of the art pack that ships.
 *
 * `TempArt/` holds 772 PNGs; this list is the ~200 the game uses. Explicit
 * rather than a directory glob on purpose: the atlas is committed, so anything
 * added here costs repo bytes forever, and the licence permits redistribution
 * only as part of a game — a glob would quietly ship the whole pack the first
 * time a new folder appeared.
 *
 * ## Hooking up new art
 *
 * `tools/ART-SURVEY.md` is the index. Run `npm run survey-art` to regenerate
 * it; it lists every sheet, what kind of sheet it is, which of its tiles tile
 * seamlessly, and the pixel rect of every sprite inside it. Find what you want
 * there, paste its rect into the right section below, and run
 * `npm run pack-sprites`.
 *
 * An entry is:
 *
 *   { key, src }                    a whole file, one subject
 *   { key, src, rect: [x,y,w,h] }   one sprite cut out of a sheet
 *   { key, src, frame: 16 }         an animation sheet on a 16px frame grid,
 *                                   packed whole; the packer counts the rows
 *
 * Any of them may also carry `trim: true`, which shrinks the result to its
 * opaque content (see `cell()` below), and `tags`, which carries the one thing
 * the key cannot say for itself — see "The key prefix is the type" below.
 *
 * `key` is what the game refers to the sprite by and is deliberately separate
 * from the filename — the pack contains apostrophes, spaces, and three
 * misspellings (`OreDesposit`, `TraningGrounds`, `SchollOfWar`), none of which
 * should reach the code.
 *
 * ## The key prefix is the type
 *
 * `city.`, `mine.`, `lair.`, `tree.` and the rest are not decoration: the packer
 * reads the prefix and emits a `role` for every sprite into `SPRITE_TAGS`, so
 * the game can ask for "a settlement building" instead of naming files. This was
 * already half-true before it was written down — `world/sites.ts` builds
 * `prop.${ground}.${i}` by string interpolation — so the rule is now enforced by
 * `ROLE_BY_PREFIX` below, and an unknown prefix fails the pack.
 *
 * Only what the prefix *cannot* express goes in `tags`: which biomes a sprite's
 * palette suits. Anything keyed by ground sheet needs not even that, because the
 * key is built from the biome's own `ground`.
 *
 * ## Rules that are not obvious
 *
 * - Anything scattered on the terrain must be a **single subject standing on
 *   the bottom edge of its rect**. The sheets' pair and trio tiles draw two or
 *   three subjects at different depths with only the nearest on the baseline;
 *   on a card standing upright on 3D ground the others hang in mid-air.
 * - Ground fill tiles are chosen by measurement, not eye — see
 *   `tools/packGround.mjs`. A tile that looks like fill usually is not.
 * - Only art drawn in **elevation** can be a card. Much of the pack is top-down:
 *   the wall enclosures on the buildings sheet, the ploughed furrows of
 *   `Universal-Fields.png`, every road and river tile. They read correctly lying
 *   on the ground and absurdly standing up on it, which is why none of them are
 *   here despite being exactly the "settlement dressing" one would reach for.
 *
 * Art: Aleksandr Makarov (@IknowKingRabbit). See src/assets/ART-CREDITS.md.
 */

// --- Source sheets ----------------------------------------------------------
// Each is catalogued in ART-SURVEY.md under its directory heading.

const TOWNS = 'HAS Buildings Pack/Towns'
const MINES = 'HAS Buildings Pack/Mines'
const RES = 'HAS Buildings Pack/Resources'
const TREASURE = 'HAS Buildings Pack/Treasures'
const MOD = 'HAS Buildings Pack/AttributeModifier'
const MISC = 'HAS Buildings Pack/Miscellaneous'
const TREES = 'HAS Overworld Starter Pack/SP-Trees.png'
/** 832x496. A 4x10 grid of species blocks; every block has an isolated single. */
const UTREES = 'Universal/Universal-Trees-And-Mountains.png'
/**
 * 192x128. Rows 0-3 are top-down wall enclosures and unusable as cards; rows 4-7
 * are 32 front-view houses, one per cell, and are the only small buildings in
 * the whole pack. Row 7 repeats row 4 with snow on the roofs.
 */
const UBUILD = 'Universal/Universal-Buildings-and-walls.png'
/** The 1.1.2 pack. Its per-biome tree sheets have no equivalent in 1.2. */
const T112 = 'Additional Materials/HAS Overworld 1.1.2'

const TILE = 16

/**
 * What a key prefix means. The packer emits this as each sprite's `role`, and
 * fails on a prefix that is not listed — a typo in a key would otherwise ship a
 * sprite the role queries can never find.
 */
export const ROLE_BY_PREFIX = {
  city: 'city',
  build: 'settlement',
  mine: 'mine',
  vein: 'vein',
  pickup: 'pickup',
  lair: 'lair',
  mod: 'landmark',
  misc: 'landmark',
  deco: 'tree',
  tree: 'tree',
  mount: 'mountain',
  prop: 'clutter',
  unit: 'unit',
}

/**
 * One grid cell — or a span x span block of them — of a sheet.
 *
 * Everything scattered on the terrain is selected this way rather than by a
 * pixel rect. The art is laid out on a 16px grid, so a cell is the unit the
 * artist actually worked in, and `tools/surveyArt.mjs` can verify a cell holds
 * exactly one safe-to-scatter subject. Hand-measured rects cannot be checked by
 * anything, which is how a 32x32 crop of the mushroom field once shipped as a
 * mountain.
 *
 * `trim` tells the packer to shrink to the opaque content, so the padding the
 * cell carries does not leave the sprite floating above the ground.
 */
function cell(col, row, span = 1) {
  return { rect: [col * TILE, row * TILE, span * TILE, span * TILE], trim: true }
}

/**
 * Surveyed but not yet used. Each is a one-line entry away.
 *
 *   Universal/Universal-FogOfWar.png            256x32  fog edge tiles
 *   Universal/Universal-Road-Tileset.png        256x176 roads
 *   Universal/Universal-River-Static.png        128x32  rivers
 *   Universal/Universal-Ocean-Static.png        128x48  open water
 *   Universal/Universal-Fields.png              128x48  ploughed fields
 *   <Biome>/Animated Tiles/*.png                        coast animations
 *   HAS Buildings Pack/**                               ~180 further buildings
 *
 * The first six are all top-down and so cannot be cards; they are waiting on a
 * ground-decal pass, not on a manifest line. The buildings are cards and are
 * simply not needed yet — the settlement set below is drawn from what reads as a
 * *dwelling*, and the rest of the pack is one-off landmarks.
 */

/**
 * Ground clutter, one set per biome.
 *
 * Every LandTileset devotes its first two rows to small props — bushes, logs,
 * pebbles, tufts, flowers, and whatever else that biome has — drawn in that
 * biome's own palette at the same grid positions. So one list of rects yields
 * a colour-matched set for all seven, which is why these are generated rather
 * than typed out.
 */
const BIOME_SHEETS = [
  ['grass', 'GrassBiome/GB-LandTileset.png'],
  ['sand', 'SandBiome/SB-LandTileset.png'],
  ['marsh', 'MarshBiome/MB-LandTileset.png'],
  ['ice', 'IceBiome/IB-LandTileset.png'],
  ['lava', 'LavaBiome/LB-LandTileset.png'],
  ['cave', 'CaveBiome/CB-LandTileset.png'],
  ['dirt', 'DirtBiome/DB-LandTileset.png'],
]

/**
 * Prop cells present in *all seven* biome sheets.
 *
 * Computed, not chosen: `survey-art` reports the single-subject cells of each
 * sheet, and these nine are the intersection. Because the sheets share a
 * layout, one list yields a colour-matched set for every biome.
 */
const PROP_CELLS = [
  [4, 0],
  [5, 0],
  [8, 0],
  [11, 0],
  [5, 1],
  [10, 1],
  [11, 1],
  [9, 3],
  [11, 3],
]

export function biomeProps() {
  const out = []
  for (const [name, rel] of BIOME_SHEETS) {
    PROP_CELLS.forEach(([col, row], i) => {
      out.push({ key: `prop.${name}.${i}`, src: rel, ...cell(col, row) })
    })
  }
  return out
}

/**
 * Vegetation, one set per biome, in that biome's own palette.
 *
 * The Universal sheet below supplies one set of trees for the whole island,
 * which meant an Ashland pine and a Meadowland pine were the same pixels and a
 * territory's identity had to come entirely from ground colour and density. The
 * 1.1.2 pack draws the same five subjects — broadleaf, bush, stump, conifer,
 * pebble — separately for each biome, which is the difference between six
 * tinted copies of one wood and six woods.
 *
 * Keyed by *ground sheet* rather than by biome id, exactly like `prop.*` above,
 * so `world/sites.ts` builds the key from `Biome.ground` and the trees can never
 * drift off the ground they stand on.
 *
 * Unlike `PROP_CELLS` these lists differ per sheet: the biomes have different
 * numbers of things growing in them, and the blocks are stacked in a different
 * order in each file. Every cell here is one `survey-art` reported under
 * "Single-subject cells" — do not add one by eye.
 */
const CANOPY_SHEETS = [
  ['grass', 'GrassBiome/GB', [[1, 0], [1, 3], [0, 6], [1, 6], [0, 9]]],
  ['dirt', 'DirtBiome/DB', [[1, 0], [1, 3], [1, 6], [1, 9], [0, 12], [1, 12], [0, 15]]],
  ['ice', 'IceBiome/IB', [[1, 0], [1, 3], [0, 6], [1, 6], [1, 9], [0, 12]]],
  ['lava', 'LavaBiome/LB', [[1, 0], [0, 3], [1, 3], [0, 6]]],
  ['marsh', 'MarshBiome/MB', [[1, 0], [1, 3], [0, 6], [1, 6], [0, 9]]],
  ['sand', 'SandBiome/SB', [[1, 0], [0, 3], [1, 3], [0, 6]]],
]

/**
 * The one big mountain each sheet carries, by hand-checked rect.
 *
 * Not by cell, because no automatic rule isolates these — each sheet's mountain
 * block draws two or three peaks shoulder to shoulder, and the pair to either
 * side of the one taken here touches it. Each rect below was cropped, trimmed
 * and looked at before it was written down; the neighbours it avoids are a
 * cave-mouth variant (a site, not scenery) and a mountain with a totem standing
 * in front of it.
 *
 * Lava is the odd one out twice over: its mountain block is two rows rather than
 * three, and the peak worth having is the volcano rather than the plain cone.
 */
const CANOPY_MOUNTS = [
  ['grass', 'GrassBiome/GB', [48, 192, 32, 48]],
  ['dirt', 'DirtBiome/DB', [48, 288, 32, 48]],
  ['ice', 'IceBiome/IB', [48, 240, 32, 48]],
  ['lava', 'LavaBiome/LB', [96, 144, 32, 32]],
  ['marsh', 'MarshBiome/MB', [48, 192, 32, 48]],
  ['sand', 'SandBiome/SB', [48, 144, 32, 48]],
]

export function biomeCanopy() {
  const out = []
  for (const [name, stem, cells] of CANOPY_SHEETS) {
    const src = `${T112}/${stem}-Trees-and-Mountains.png`
    cells.forEach(([col, row], i) => {
      out.push({ key: `tree.${name}.${i}`, src, ...cell(col, row) })
    })
  }
  for (const [name, stem, rect] of CANOPY_MOUNTS) {
    out.push({
      key: `mount.${name}`,
      src: `${T112}/${stem}-Trees-and-Mountains.png`,
      rect,
      trim: true,
    })
  }
  return out
}

/**
 * The small buildings a settlement is made of.
 *
 * All 32 come from four rows of one sheet, because they are the only dwellings
 * in the pack drawn small enough and plainly enough to crowd around a town
 * without competing with it. Everything in `HAS Buildings Pack` is a *landmark* —
 * a named structure with its own silhouette — and eight of those in a circle
 * reads as eight quest markers, not as a village.
 *
 * `survey-art` verifies only seven of these cells, because its rule demands
 * clear transparent columns on both sides and the artist packed the houses edge
 * to edge. They were checked the other way instead: every cell in rows 4-7 was
 * cropped and rendered, and each holds one whole house with nothing of its
 * neighbours in it.
 *
 * Row 7 is row 4 with snow on the roofs, which is why Frostmark gets a village
 * of its own rather than the same huts under a different sky.
 */
const HOUSE_ROWS = [
  // key stem, sheet row, columns, biomes the palette suits
  ['house', 4, [3, 4, 5, 6, 7, 8, 9, 10, 11], ['meadow', 'wildwood', 'highland']],
  ['shop', 5, [3, 4, 5, 6, 7, 8, 9, 10, 11], ['meadow', 'wildwood']],
  ['tent', 6, [3, 4, 5, 6, 7], ['highland', 'blight', 'ashland']],
  ['snow', 7, [3, 4, 5, 6, 7, 8, 9, 10, 11], ['frostmark']],
  // Market stalls and a workbench. Filler between the houses, not dwellings.
  ['stall', 4, [0, 1, 2], ['meadow', 'wildwood', 'highland', 'blight']],
]

export function settlementSprites() {
  const out = []
  for (const [stem, row, cols, biomes] of HOUSE_ROWS) {
    cols.forEach((col, i) => {
      out.push({ key: `build.${stem}.${i}`, src: UBUILD, ...cell(col, row), tags: { biomes } })
    })
  }
  return out
}

/** @type {{ key: string, src: string, cols?: number, rows?: number }[]} */
export const SPRITES = [
  // --- Cities. 64x64, one per faction. -------------------------------------
  { key: 'city.castle', src: `${TOWNS}/Castle.png` },
  { key: 'city.rampart', src: `${TOWNS}/Rampart.png` },
  { key: 'city.tower', src: `${TOWNS}/Tower.png` },
  { key: 'city.inferno', src: `${TOWNS}/Inferno.png` },
  { key: 'city.necropolis', src: `${TOWNS}/Necropolis.png` },
  { key: 'city.stronghold', src: `${TOWNS}/Stronghold.png` },

  // --- Resource production, built. 32x32. ----------------------------------
  { key: 'mine.sawmill', src: `${MINES}/Sawmill/Sawmill.png` },
  { key: 'mine.orePit', src: `${MINES}/OrePit/OrePit.png` },
  { key: 'mine.gold', src: `${MINES}/GoldMine/GoldMine.png` },
  { key: 'mine.crystal', src: `${MINES}/CrystalMine/CrystalMine.png` },
  { key: 'mine.gem', src: `${MINES}/GemMine/GemMine.png` },
  { key: 'mine.sulfur', src: `${MINES}/SulfurMine/SulfurMine.png` },
  { key: 'mine.alchemist', src: `${MINES}/AlchemistLab/AlchemistLab.png` },
  { key: 'mine.waterMill', src: `${MINES}/WaterMill/WaterMill.png` },
  { key: 'mine.windMill', src: `${MINES}/WindMill/WindMill.png` },
  { key: 'mine.dwarvenWarren', src: `${MINES}/DwarvenWarren/DwarvenWarren.png` },

  // --- Raw deposits: the unclaimed precursor tier. -------------------------
  { key: 'vein.wood', src: `${MINES}/Sawmill/WoodPile.png` },
  { key: 'vein.ore', src: `${MINES}/OrePit/OreDesposit.png` },
  { key: 'vein.gold', src: `${MINES}/GoldMine/GoldVein.png` },
  { key: 'vein.crystal', src: `${MINES}/CrystalMine/CrystalVein.png` },
  { key: 'vein.gem', src: `${MINES}/GemMine/GemVein.png` },
  { key: 'vein.sulfur', src: `${MINES}/SulfurMine/SulfurVein.png` },
  { key: 'vein.mercury', src: `${MINES}/AlchemistLab/CinnabarVein.png` },

  // --- Loose pickups. 16x16. -----------------------------------------------
  { key: 'pickup.gold', src: `${RES}/Gold.png` },
  { key: 'pickup.wood', src: `${RES}/Wood.png` },
  { key: 'pickup.ore', src: `${RES}/Ore.png` },
  { key: 'pickup.gems', src: `${RES}/Gems.png` },
  { key: 'pickup.crystal', src: `${RES}/Crystal.png` },
  { key: 'pickup.sulfur', src: `${RES}/Sulfur.png` },
  { key: 'pickup.mercury', src: `${RES}/Mercury.png` },
  { key: 'pickup.chest', src: `${RES}/Chest.png` },
  { key: 'pickup.campfire', src: `${RES}/Campfire.png` },
  { key: 'pickup.wagon', src: `${RES}/Wagon.png` },

  // --- Neutral monster locations. 32x32 unless noted. ----------------------
  { key: 'lair.lair', src: `${TREASURE}/Lair.png` },
  { key: 'lair.snake', src: `${TREASURE}/SnakeLair.png` },
  { key: 'lair.cyclops', src: `${TREASURE}/CyclopsLair.png` },
  { key: 'lair.daemonCave', src: `${TREASURE}/DaemonCave.png` },
  { key: 'lair.graveyard', src: `${TREASURE}/Graveyard.png` },
  { key: 'lair.cityOfTheDead', src: `${TREASURE}/CityOfTheDead.png` },
  { key: 'lair.griffinTower', src: `${TREASURE}/GriffinTower.png` },
  { key: 'lair.medusaBank', src: `${TREASURE}/MedusaBank.png` },
  { key: 'lair.dwarfFortress', src: `${TREASURE}/DwarfFortress.png` },
  { key: 'lair.dwarvenTreasury', src: `${TREASURE}/DwarvenTreasury.png` },
  { key: 'lair.elementalStockpile', src: `${TREASURE}/ElementalStockpile.png` },
  { key: 'lair.impCache', src: `${TREASURE}/ImpCache.png` },
  { key: 'lair.keep', src: `${TREASURE}/Keep.png` },
  { key: 'lair.maze', src: `${TREASURE}/Maze.png` },
  { key: 'lair.oldTreeNests', src: `${TREASURE}/OldTreeNests.png` },
  { key: 'lair.ruins', src: `${TREASURE}/Ruins.png` },
  { key: 'lair.bloodTemple', src: `${TREASURE}/BloodTemple.png` },
  { key: 'lair.vaultOfTheMages', src: `${TREASURE}/VaultOfTheMages.png` },
  // 64x48 — the single hardest lair on the map.
  { key: 'lair.dragonCity', src: `${TREASURE}/DragonCity.png` },

  // --- Landmarks and modifiers. --------------------------------------------
  { key: 'mod.fort', src: `${MOD}/Fort.png` },
  { key: 'mod.tower', src: `${MOD}/Tower.png` },
  { key: 'mod.temple', src: `${MOD}/Temple.png` },
  { key: 'mod.templeOfNature', src: `${MOD}/TempleOfNature.png` },
  { key: 'mod.templeOfOrder', src: `${MOD}/TempleOfOrder.png` },
  { key: 'mod.standingStones', src: `${MOD}/StandingStones.png` },
  { key: 'mod.sphinx', src: `${MOD}/Sphinx.png` },
  { key: 'mod.fairyRing', src: `${MOD}/FairyRing.png` },
  { key: 'mod.oasis', src: `${MOD}/Oasis.png` },
  { key: 'mod.arena', src: `${MOD}/Arena.png` },
  { key: 'mod.mercenaryCamp', src: `${MOD}/MercenaryCamp.png` },
  { key: 'mod.library', src: `${MOD}/Library.png` },
  { key: 'mod.gazebo', src: `${MOD}/Gazebo.png` },
  { key: 'mod.shrine1', src: `${MOD}/ShrineOfMagicLvl1.png` },
  { key: 'mod.shrine2', src: `${MOD}/ShrineOfMagicLvl2.png` },
  { key: 'mod.shrine3', src: `${MOD}/ShrineOfMagicLvl3.png` },

  // --- Services, and the three map-reveal buildings. -----------------------
  // Cartographer / Observatory / Eye of the Magi are canonically map-reveal
  // structures, which gives fog of war a reward for exploring rather than a
  // menu toggle. That is why they are in the shipped set.
  { key: 'misc.cartographer', src: `${MISC}/Cartographer.png` },
  { key: 'misc.observatory', src: `${MISC}/RedwoodObservatory.png` },
  { key: 'misc.eyeOfTheMagi', src: `${MISC}/EyeOfTheMagi.png` },
  { key: 'misc.tavern', src: `${MISC}/Tavern.png` },
  { key: 'misc.tradingPost', src: `${MISC}/TradingPost.png` },
  { key: 'misc.stables', src: `${MISC}/Stables.png` },
  { key: 'misc.oracle', src: `${MISC}/Oracle.png` },
  { key: 'misc.seersHut', src: `${MISC}/Seer'sHut.png` },
  { key: 'misc.blackMarket', src: `${MISC}/BlackMarket.png` },
  { key: 'misc.monolithEntrance', src: `${MISC}/OneWayMonolithEntrance.png` },
  { key: 'misc.monolithExit', src: `${MISC}/OneWayMonolithExit.png` },

  // --- Decoration: single trees and mountains ------------------------------
  // Every entry is one verified grid cell of the Universal sheet. `survey-art`
  // lists these under "Single-subject cells": one connected subject, clear of
  // its neighbours on both sides. The cells sit at column 1, 14, 27 or 40 —
  // offset 1 within each of the sheet's four 13-column species blocks.
  { key: 'deco.oak', src: UTREES, ...cell(1, 0) },
  { key: 'deco.deadBare', src: UTREES, ...cell(14, 0) },
  { key: 'deco.autumn', src: UTREES, ...cell(27, 0) },
  { key: 'deco.snowy', src: UTREES, ...cell(40, 0) },
  { key: 'deco.fir', src: UTREES, ...cell(1, 3) },
  { key: 'deco.frostFir', src: UTREES, ...cell(14, 3) },
  { key: 'deco.coralBlue', src: UTREES, ...cell(27, 3) },
  { key: 'deco.birch', src: UTREES, ...cell(1, 6) },
  { key: 'deco.birchAutumn', src: UTREES, ...cell(14, 6) },
  { key: 'deco.birchSnowy', src: UTREES, ...cell(27, 6) },
  { key: 'deco.deadTwisted', src: UTREES, ...cell(40, 6) },
  { key: 'deco.pine', src: UTREES, ...cell(1, 9) },
  { key: 'deco.darkPine', src: UTREES, ...cell(14, 9) },
  { key: 'deco.fern', src: UTREES, ...cell(1, 12) },
  { key: 'deco.coralRed', src: UTREES, ...cell(27, 12) },
  { key: 'deco.lavaSpout', src: UTREES, ...cell(40, 12) },
  { key: 'deco.palm', src: UTREES, ...cell(1, 15) },
  { key: 'deco.shrub', src: UTREES, ...cell(14, 15) },
  { key: 'deco.bloom', src: UTREES, ...cell(40, 15) },
  { key: 'deco.flame', src: UTREES, ...cell(40, 18) },
  { key: 'deco.bush', src: UTREES, ...cell(0, 21) },
  { key: 'deco.cactus', src: UTREES, ...cell(1, 21) },
  { key: 'deco.mushroom', src: UTREES, ...cell(1, 27) },

  // The one exception to single cells: the artist drew the big mountains across
  // a 2x2, and they touch their neighbours, so no automatic rule isolates them.
  // These four were picked by hand and then checked — 687 px each, bottom gap
  // 0-1, one mountain per block. The +2 offsets in the same row are full 1024px
  // cluster tiles and must not be used.
  { key: 'deco.mountainBrown', src: UTREES, ...cell(0, 25, 2) },
  { key: 'deco.mountainSand', src: UTREES, ...cell(13, 25, 2) },
  { key: 'deco.mountainGrey', src: UTREES, ...cell(26, 25, 2) },
  { key: 'deco.mountainSnow', src: UTREES, ...cell(39, 25, 2) },
]

/**
 * Creature sprite sheets, packed whole.
 *
 * Every sheet is 4 columns x 5 rows of 16x16 frames: columns are animation
 * frames, rows are Idle / Walk / Attack / Damage / Death (TempArt/tips.txt).
 * A few are 4x6 with a trailing "special" row; the extra row is packed and
 * ignored, which costs a handful of texels and avoids a per-unit exception.
 *
 * Rosters are ordered weakest-first — site placement maps a difficulty tier to
 * an index in this array, so the order is load-bearing, not cosmetic.
 *
 * A unit is either a bare name (folder and sheet share it) or `[name, file]`
 * where the pack's filename disagrees with its folder. Two such cases exist:
 *   - `gargoyle` ships as `sprite_sheet_garoyle_...` — a typo in the pack.
 *   - `wizards/mage` has no mage sheet at all; the folder contains a duplicate
 *     of the djinn sheet. Only the mage *icons* are real, so the mage is left
 *     out of the roster until there is art for it. Do not "fix" this by
 *     pointing it at the djinn sheet — two roster slots with identical
 *     creatures on screen reads as a bug.
 */
export const UNIT_ROSTERS = {
  castle: { dir: 'castle', units: ['peasant', 'pikeman', 'archer', 'swordsman', 'monk', 'cavalier', 'griffin', 'paladin', 'angel'] },
  necropolis: { dir: 'necropolis', units: ['skeleton', 'zombie', 'ghost', 'spider', 'vampire', 'lich', 'death knight'] },
  darkBastion: { dir: 'dark bastion', units: ['imp', 'gog', 'hell hound', 'demon', 'pit fiend', 'efreet', 'devil'] },
  stronghold: { dir: 'stronghold', units: ['goblin', 'wolf rider', 'centaur', 'harpy', 'shaman', 'troll', 'cyclop'] },
  wizards: { dir: 'wizards', units: ['gremlin', ['gargoyle', 'garoyle'], 'golem', 'djinn', 'naga', 'lion', 'titan'] },
  greatElf: { dir: 'great elf', units: ['pixie', 'deer', 'dwarf', 'hunter', 'druid', 'satyr', 'treant'] },
  elementals: { dir: 'elementals', units: ['stone elemental', 'ice elemental', 'fire elemental', 'water elemental', 'wind elemental', 'magma elemental', 'storm elemental', 'mind elemental', 'magic elemental', 'diamond elemental'] },
}

/** Expand the rosters into manifest entries. Base tier only for now. */
export function unitSprites() {
  const out = []
  for (const [faction, { dir, units }] of Object.entries(UNIT_ROSTERS)) {
    for (const unit of units) {
      const [name, fileName] = Array.isArray(unit) ? unit : [unit, unit]
      const file = fileName.replace(/ /g, '_')
      out.push({
        key: `unit.${faction}.${name.replace(/ /g, '_')}`,
        src: `${dir}/${name}/sprite_sheet_${file}_0_16x16.png`,
        // The grid is derived from the image, not declared. A handful of these
        // sheets carry a sixth "special" row; every entry declaring `rows: 5`
        // made a frame on those 96/5 = 19.2 px tall instead of 16, which would
        // sample every row of those units off-grid the moment anything indexed
        // one. A number that can disagree with the art eventually does.
        frame: 16,
      })
    }
  }
  return out
}

/**
 * What gets packed, and into which file.
 *
 * Two atlases rather than one, because the creature sheets are half the pixels
 * and none of the game: a 64x80 walk cycle is eight times the area of the town
 * it would garrison, 54 of them filled the top half of the texture, and nothing
 * draws them — there is no animation driver yet. Splitting them out is what pays
 * for the trees and houses above without the committed binary growing.
 *
 * `units` is packed and committed but never loaded. That is deliberate: the
 * pack step is the expensive, TempArt-requiring half, so leaving it done means
 * wiring creatures up later is a renderer change and not an art change. See
 * `src/render/spriteAtlas.ts` for how a second atlas gets loaded.
 *
 * Keys must be unique across *all* groups, not within one — they are one
 * namespace to the game whatever file they live in.
 */
export const ATLASES = [
  {
    name: 'sprites',
    entries: [...SPRITES, ...biomeProps(), ...biomeCanopy(), ...settlementSprites()],
  },
  { name: 'units', entries: unitSprites() },
]
