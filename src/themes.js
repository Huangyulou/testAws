import { TILE_TYPES } from './game.js';

const orchardFaces = TILE_TYPES.map(({ emoji, name, hue }) => ({
  symbol: emoji,
  name,
  hue,
}));

const cartoonFaces = [
  { symbol: '🐶', name: '小狗', hue: 28 },
  { symbol: '🐱', name: '小猫', hue: 40 },
  { symbol: '🐰', name: '小兔', hue: 330 },
  { symbol: '🐼', name: '熊猫', hue: 210 },
  { symbol: '🦊', name: '狐狸', hue: 18 },
  { symbol: '🐻', name: '小熊', hue: 26 },
  { symbol: '🐸', name: '青蛙', hue: 118 },
  { symbol: '🐵', name: '猴子', hue: 35 },
  { symbol: '🐷', name: '小猪', hue: 345 },
  { symbol: '🐨', name: '考拉', hue: 198 },
  { symbol: '🦁', name: '狮子', hue: 44 },
  { symbol: '🐯', name: '老虎', hue: 32 },
  { symbol: '🐮', name: '小牛', hue: 225 },
  { symbol: '🐙', name: '章鱼', hue: 305 },
  { symbol: '🐳', name: '鲸鱼', hue: 205 },
  { symbol: '🦄', name: '独角兽', hue: 285 },
];

const fantasyFaces = [
  { symbol: '金', name: '金石', hue: 45 },
  { symbol: '木', name: '青木', hue: 145 },
  { symbol: '水', name: '玄水', hue: 200 },
  { symbol: '火', name: '赤火', hue: 12 },
  { symbol: '土', name: '厚土', hue: 35 },
  { symbol: '日', name: '曜日', hue: 48 },
  { symbol: '月', name: '皓月', hue: 250 },
  { symbol: '星', name: '星辰', hue: 52 },
  { symbol: '云', name: '流云', hue: 190 },
  { symbol: '风', name: '疾风', hue: 160 },
  { symbol: '雷', name: '惊雷', hue: 268 },
  { symbol: '电', name: '紫电', hue: 282 },
  { symbol: '光', name: '流光', hue: 55 },
  { symbol: '暗', name: '暗影', hue: 238 },
  { symbol: '灵', name: '灵韵', hue: 172 },
  { symbol: '丹', name: '金丹', hue: 22 },
];

/**
 * Visual skins. Gameplay types stay the same; every skin maps all types to a
 * readable symbol, name and hue so switching never touches the board state.
 */
export const THEMES = Object.freeze({
  orchard: Object.freeze({
    label: '果园',
    tagline: '连起同款，清空整盘',
    eyebrow: '经典连线消除',
    startTitle: '来一局连连看',
    logo: ['🍓', '🍋'],
    themeColor: '#0f8f7a',
    faces: Object.freeze(orchardFaces),
  }),
  cartoon: Object.freeze({
    label: '卡通',
    tagline: '萌趣连击，清空全场',
    eyebrow: '萌趣连线大作战',
    startTitle: '一起连连看！',
    logo: ['🐻', '🐱'],
    themeColor: '#2f6fed',
    faces: Object.freeze(cartoonFaces),
  }),
  fantasy: Object.freeze({
    label: '玄幻',
    tagline: '以灵为引，破阵除妖',
    eyebrow: '灵石秘境 · 连线破阵',
    startTitle: '入阵，破局',
    logo: ['月', '星'],
    themeColor: '#0b211d',
    faces: Object.freeze(fantasyFaces),
  }),
});

export const THEME_ORDER = Object.freeze(['orchard', 'cartoon', 'fantasy']);

export function resolveTheme(value) {
  return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : 'orchard';
}
