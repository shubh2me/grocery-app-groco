// Auto-generated product picture (SVG). Used whenever a product has no photo,
// or its photo link is broken, so the store never shows an empty/broken image.
const CAT_EMOJI = {
  vegetables: '🥦', fruits: '🍎', 'dairy-eggs': '🥛', 'biscuits-cookies': '🍪', 'chocolates-sweets': '🍫',
  'icecream-frozen': '🍨', 'snacks-namkeen': '🍟', 'drinks-beverages': '🥤', 'tea-coffee': '☕',
  'atta-flour': '🌾', 'rice-grains': '🍚', 'dal-pulses': '🫘', 'oil-ghee': '🫒', 'spices-masala': '🌶️',
  'sugar-sweeteners': '🍯', 'sauces-spreads': '🍅', 'instant-packaged': '🍜', 'frozen-food': '🧊', bakery: '🍞',
  'dry-fruits': '🥜', 'personal-care': '🧴', 'cleaning-household': '🧽', 'paper-disposable': '🧻',
  'baby-care': '🍼', 'pet-supplies': '🐾'
};
const KEYWORDS = [
  [/chocolate|kitkat|dairy milk|silk/, '🍫'], [/ginger|adrak/, '🌿'], [/bell pepper|capsicum|shimla mirch/, '🫑'], [/dragon fruit/, '🐉'],
  [/egg/, '🥚'], [/butter(?! chicken)/, '🧈'], [/paneer|cheese/, '🧀'], [/curd|dahi|yogurt|lassi/, '🥣'], [/milk/, '🥛'],
  [/banana|kela/, '🍌'], [/mango/, '🥭'], [/papaya|papita/, '🥭'], [/orange|lemon|nimbu|citrus|mosambi/, '🍊'],
  [/grape/, '🍇'], [/watermelon/, '🍉'], [/avocado/, '🥑'], [/apple/, '🍎'], [/pomegranate|anar/, '🍎'], [/strawberr/, '🍓'],
  [/tomato(?! ketchup)/, '🍅'], [/potato|aloo/, '🥔'], [/onion|pyaz/, '🧅'], [/garlic|lehsun/, '🧄'], [/carrot|gajar/, '🥕'],
  [/broccoli/, '🥦'], [/cabbage|cauliflower|palak|spinach|coriander|methi|leaf/, '🥬'], [/capsicum|shimla/, '🫑'],
  [/chilli|chili|mirch/, '🌶️'], [/corn/, '🌽'], [/cucumber|kheera/, '🥒'], [/brinjal|baingan/, '🍆'], [/mushroom/, '🍄'],
  [/bread|pav|bun\b|rusk/, '🍞'], [/cake|muffin/, '🧁'], [/croissant/, '🥐'], [/cookie|biscuit|cracker|wafer/, '🍪'],
  [/chocolate|kitkat|dairy milk|silk/, '🍫'], [/candy|candies|toffee|alpenliebe/, '🍬'], [/ice cream|kulfi|cornetto/, '🍨'],
  [/popcorn/, '🍿'], [/chips|nachos|kurkure|namkeen|bhujia|sev|mixture|fries/, '🍟'], [/peanut butter/, '🥜'],
  [/almond|cashew|pista|walnut|peanut|nuts|badam|kaju/, '🥜'], [/raisin|kishmish/, '🍇'], [/dates|khajur/, '🌴'],
  [/noodle|maggi|yippee/, '🍜'], [/pasta|penne|macaroni/, '🍝'], [/soup/, '🍲'], [/momo/, '🥟'], [/nugget|chicken/, '🍗'],
  [/juice/, '🧃'], [/cola|thums|pepsi|sprite|soda|soft drink|energy|red bull/, '🥤'], [/water|bisleri/, '💧'], [/coconut/, '🥥'],
  [/green tea|tea|chai/, '🍵'], [/coffee|nescafe|bru\b/, '☕'], [/horlicks|bournvita|boost|health drink|hot chocolate/, '🥛'],
  [/honey/, '🍯'], [/jaggery|gur\b|sugar/, '🍬'], [/salt/, '🧂'], [/ghee/, '🧈'], [/oil/, '🫒'],
  [/rice|poha|dalia|basmati/, '🍚'], [/atta|flour|maida|besan|suji|rava/, '🌾'], [/dal\b|rajma|chana|moong|toor|urad|masoor|pulse/, '🫘'],
  [/masala|haldi|turmeric|jeera|powder|spice/, '🌶️'], [/ketchup|sauce/, '🍅'], [/jam\b/, '🍓'],
  [/soap|bath|body wash/, '🧼'], [/shampoo|conditioner|hair/, '🧴'], [/toothpaste|oral|toothbrush/, '🪥'],
  [/deodorant|deo\b|perfume/, '🧴'], [/shaving|razor/, '🪒'], [/detergent|laundry|surf|ariel|rin\b/, '🧺'],
  [/dishwash|vim\b/, '🍽️'], [/floor|toilet|cleaner|harpic|lizol/, '🧽'], [/garbage|bin bag/, '🗑️'], [/freshener|odonil/, '🌸'],
  [/tissue|toilet paper|paper towel|napkin/, '🧻'], [/foil|wrap/, '📦'], [/diaper|pampers/, '👶'], [/baby|wipes/, '🍼'],
  [/dog|pedigree|drools/, '🐕'], [/cat food|whiskas|me-o/, '🐈'], [/pet/, '🐾'], [/frozen/, '🧊']
];
function emojiFor(p) {
  const t = ((p.title || '') + ' ' + (p.subcategory || '')).toLowerCase();
  for (const [re, e] of KEYWORDS) if (re.test(t)) return e;
  return CAT_EMOJI[p.category] || '🛒';
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function wrap(text, max, lines) {
  const words = String(text || '').split(/\s+/), out = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/.{1,2}$/, '') + '…'; }
  return out;
}
function tileSvg(p) {
    let h = 0; for (const ch of String(p.category || 'x')) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const emoji = emojiFor(p), sans = "'Poppins','Segoe UI',Arial,sans-serif";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},75%,94%)"/><stop offset="1" stop-color="hsl(${(h + 35) % 360},70%,86%)"/></linearGradient></defs>
<rect width="300" height="300" fill="url(#g)"/>
<circle cx="150" cy="125" r="94" fill="#fff" fill-opacity=".7"/>
<text x="150" y="165" text-anchor="middle" font-size="112" font-family="'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif">${emoji}</text>
<text x="150" y="258" text-anchor="middle" font-size="21" font-weight="700" font-family="${sans}" fill="#1e293b">${esc(String(p.brand || p.title || '').slice(0, 22))}</text>
<text x="150" y="282" text-anchor="middle" font-size="15" font-family="${sans}" fill="#475569">${esc(p.variant || '')}</text>
</svg>`;
}
module.exports = { tileSvg, emojiFor, CAT_EMOJI };
