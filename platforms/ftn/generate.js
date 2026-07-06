// Génération de pseudos candidats (pour ensuite les scanner en masse).
// Modes : aléatoire, prononçable, pattern (gabarit), dictionnaire.
// Filtres : OG (lettres only), sans répétition adjacente, sans doublons.

const SETS = {
  alpha: 'abcdefghijklmnopqrstuvwxyz',
  alphanum: 'abcdefghijklmnopqrstuvwxyz0123456789',
  full: 'abcdefghijklmnopqrstuvwxyz0123456789_',
};
const VOWELS = 'aeiou';
const CONSON = 'bcdfghjklmnpqrstvwxyz';

// Petit dictionnaire de mots courts (3-5 lettres) pour le mode dictionnaire.
const DICT = (
  'ace ago air all and ant any arc ark arm art ash ask axe bad bag ban bar bat bay bed bee ' +
  'bet big bit boa bob bog bot bow box boy bud bug bus but cab cap car cat cod cog cop cot ' +
  'cow cry cub cup cut dab dad dam day den dew dig dim dip doe dog dot dry dub due dug dye ' +
  'ear eat eel egg ego elf elk elm end era eve eye fan far fat fax fed fee few fig fin fir ' +
  'fit fix fly fob foe fog for fox fry fun fur gap gas gel gem get gig god got gum gun gut ' +
  'guy gym ham hat hay hen hex hip hit hog hop hot how hub hue hug hut ice icy ink inn ion ' +
  'ivy jab jam jar jaw jay jet jig job jog jot joy jug key kid kin kit koi lab lad lag lap ' +
  'law lay led leg let lid lip lit log lot low mad map mat max may men met mix mob mod mom ' +
  'mop mud mug nap net new nib nod nor now nut oak oar oat odd off oil old one orb ore owl ' +
  'own pad pal pan paw pay pea pen pet pie pig pin pit pod pop pot pro pry pub pug pun pup ' +
  'rad rag ram rat raw ray red rib rid rig rim rip rob rod row rub rug rum run rye sad sag ' +
  'sap saw sea set sew shy sin sip sir sit six ski sky sly sob sod son sow soy spa spy sty ' +
  'sub sum sun tab tad tag tan tap tar tax tea ten tic tie tin tip toe ton top tow toy try ' +
  'tub tug two urn use van vat vet via vie vow wad wag war wax way web wed wet who why wig ' +
  'win wit wok won wow yak yam yap yaw yen yes yet yew zap zip zit zoo ' +
  'able acid aged also army atom aqua aura away axis baby back bald ball band bank bare ' +
  'bark barn base bass bath beam bean bear beat beef been beer bell belt bend best bike ' +
  'bill bind bird bite blob blue boat body bold bolt bomb bond bone book boom boot bore ' +
  'boss both bowl bulk bull bump bunk burn bush bust busy byte cafe cage cake call calm ' +
  'camp cane cape card care cart case cash cast cave cell cent chef chip city clan clap ' +
  'claw clay clip club clue coal coat code coil coin cola cold colt comb cone cook cool ' +
  'cope copy cord core cork corn cost cove crab crew crop crow cube cult curl cute dark ' +
  'dart dash data date dawn dead deal dear debt deck deep deer demo dent desk dial dice ' +
  'diet dime dine dire dirt dish dock doll dome done doom door dose dove down drag draw ' +
  'drip drop drum dual duck dude duel duke dull dune dusk dust duty each earn ease east ' +
  'easy echo edge edit epic even ever evil exit face fact fade fail fair fake fall fame ' +
  'fang fare farm fast fate fawn fear feat feed feel fern fest file fill film find fine ' +
  'fire firm fish fist five flag flat flaw flea fled flee flip flow flux foam foil fold ' +
  'folk font food fool foot ford fore fork form fort foul four fowl frog fuel full fume ' +
  'fund fury fuse gain gala gale game gang gate gaze gear gene gift gild girl give glad ' +
  'glow glue goal goat gold golf gone good gore gown grab gray grew grid grim grin grip ' +
  'grow grub gulf gull guru gush gust hack hail hair half hall halo hand hang hard hare ' +
  'hark harm hate haul have hawk haze head heal heap heat heir helm herb herd hero hide ' +
  'hill hint hire hive hold hole holy home hood hoof hook hoop hope horn hose host hour ' +
  'howl hulk hull hunt hurt hush hymn icon idea idle idol inch iris iron isle item jade ' +
  'jail jazz jean jest join joke jolt jump june junk jury just kale keen keep kelp kept ' +
  'kick kill kiln kind king kiss kite kiwi knee knot know lace lack lady lake lamb lamp ' +
  'land lane lard lark lash lava lawn laze lazy lead leaf leak lean leap left lend lens ' +
  'lick life lift like lily limb lime limp line link lint lion list live load loaf loan ' +
  'lock loft lone long look loom loop loot lord lore lose loss loud love luck lump lung ' +
  'lure lush lynx mace maid mail main make male mall malt mane many mare mark mars ' +
  'mask mass mast mate math maze meal mean meat meld melt mesh mess mild mile milk mill ' +
  'mind mine mint mist mite moat mode mold mole monk mood moon moss most moth move much ' +
  'mule nail name nape navy near neat neck need neon nest news next nice nick node ' +
  'noon norm nose note noun nova nude oath oboe odor ogre okay omen once only onto onyx ' +
  'ooze opal open oval oven over pace pack pact page paid pain pair pale palm pane park ' +
  'part pass past path pave pawn peak peal pear peat peck peek peel peer pest pick pier ' +
  'pike pile pill pine ping pink pint pipe plan play plea plot plow plug plum plus poem ' +
  'poet poke pole poll pond pony pool poor pope pork port pose posh post pour pray prep ' +
  'prey prim prod prof prom prop pull pulp pump punk pure push quad quay quid quit quiz ' +
  'race rack raft rage raid rail rain rake ramp rank rant rare rash rate rave read real ' +
  'ream reap rear reed reef reel rely rent rest rice rich ride rift ring riot ripe rise ' +
  'risk road roam roar robe rock rode role roll roof rook room root rope rose ruby rude ' +
  'ruin rule rush rust ruth sack safe saga sage said sail sake sale salt same sand sane ' +
  'sang sash save scan scar seal seam seat seed seek seem seen self sell semi send sent ' +
  'ship shoe shop shot show sick side sift sign silk sill silo sing sink site size skew ' +
  'skid skin skip slab slam slap slat sled slid slim slip slit slot slow slug slum snap ' +
  'snow soak soap soar sock soda sofa soft soil sold sole solo some song sore sort ' +
  'soul soup sour span spar spin spot spun spur star stay stem step stew stir stop stub ' +
  'stud stun such suit sung sunk sure surf swan swap swim tail tale talk tall tame tank ' +
  'tape task taut taxi team tear teen tell tend tent term test text than that thaw them ' +
  'then thin this thud thug tide tidy tier tile till tilt time tint tiny tire toad toll ' +
  'tomb tone tool toot tore torn toss tour town trap tray tree trek trim trio trip trod ' +
  'true tsar tuba tube tuck tuna tune turf turn tusk twig twin type tyre ugly undo unit ' +
  'upon urge used user vain vale vamp vane vary vase vast veal veil vein vent verb very ' +
  'vest veto vial vibe vice view vine visa void volt vote wade wage wail wait wake walk ' +
  'wall wand wane want ward ware warm warn warp wart wary wash wasp wave wavy waxy weak ' +
  'wear weed week weep weld well went wept were west what when whim whip whiz ' +
  'wick wide wife wild will wilt wind wine wing wink wipe wire wise wish wisp with wolf ' +
  'wood wool word wore work worm worn wrap wren yard yarn yawn yeah year yell yoga yolk ' +
  'yore your zeal zero zest zinc zone zoom'
).split(/\s+/).filter(Boolean);

function pick(str) { return str[(Math.random() * str.length) | 0]; }

function genOne(mode, { length, charset, pattern }) {
  const chars = SETS[charset] || SETS.alpha;
  if (mode === 'pattern') {
    let s = '';
    for (const ch of pattern || '') {
      if (ch === '?') s += pick(SETS.alpha);
      else if (ch === '#') s += pick('0123456789');
      else if (ch === '*') s += pick(SETS.alphanum);
      else s += ch; // littéral
    }
    return s;
  }
  if (mode === 'pronounceable') {
    let s = '';
    for (let i = 0; i < length; i++) s += (i % 2 === 0) ? pick(CONSON) : pick(VOWELS);
    return s;
  }
  let s = '';
  for (let i = 0; i < length; i++) s += pick(chars);
  return s;
}

function passesFilters(name, { noRepeat, og } = {}) {
  if (og && !/^[a-z]+$/.test(name)) return false; // OG = lettres uniquement
  if (noRepeat && /(.)\1/.test(name)) return false; // pas de doublon adjacent
  return true;
}

export function generateNames(opts = {}) {
  const {
    mode = 'random', length = 3, charset = 'alpha', count = 50,
    pattern = '', filters = {}, exhaustive = false,
  } = opts;
  const len = Math.max(3, Math.min(16, length | 0));
  const target = Math.max(1, Math.min(50000, count | 0));

  if (mode === 'dict') {
    let words = DICT.filter((w) => w.length === len);
    if (!words.length) words = DICT.filter((w) => w.length <= len && w.length >= 3);
    words = words.filter((w) => passesFilters(w, filters));
    shuffle(words);
    return words.slice(0, target);
  }

  if (mode === 'pattern' && !/[?#*]/.test(pattern)) {
    const one = genOne('pattern', { pattern });
    return passesFilters(one, filters) ? [one] : [];
  }

  if (exhaustive && mode === 'random' && Math.pow((SETS[charset] || SETS.alpha).length, len) <= 60000) {
    return enumerate(SETS[charset] || SETS.alpha, len).filter((w) => passesFilters(w, filters));
  }

  const out = new Set();
  let guard = target * 60 + 2000;
  while (out.size < target && guard-- > 0) {
    const s = genOne(mode, { length: len, charset, pattern });
    if (s.length >= 3 && s.length <= 16 && passesFilters(s, filters)) out.add(s);
  }
  return [...out];
}

function enumerate(chars, length) {
  let acc = [''];
  for (let i = 0; i < length; i++) {
    const next = [];
    for (const p of acc) for (const cch of chars) next.push(p + cch);
    acc = next;
  }
  return acc;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } }

export function spaceSize(length, charset = 'alpha') {
  const chars = SETS[charset] || SETS.alpha;
  return Math.pow(chars.length, Math.max(3, Math.min(16, length | 0)));
}

const DICT_SET = new Set(DICT);
export function isDictWord(s) { return DICT_SET.has(String(s).toLowerCase()); }
