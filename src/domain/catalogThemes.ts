/**
 * Temáticas do catálogo digital. Cada uma é só configuração visual (cores, fontes, enfeites,
 * banner e textos sugeridos): trocar a temática nunca mexe em produtos, preços ou kits.
 * Para criar uma temática nova basta acrescentar um item aqui.
 */
export type ThemeId =
  | 'natal' | 'ano_novo' | 'carnaval' | 'black_friday' | 'dia_das_maes' | 'dia_dos_pais'
  | 'namorados' | 'pascoa' | 'criancas' | 'halloween' | 'verao' | 'corporativo' | 'eventos' | 'religioso' | 'minimalista' | 'personalizado';

export interface CatalogTheme {
  id: ThemeId;
  name: string;
  /** Emojis usados como enfeites (cantos do banner, separadores). */
  ornaments: string[];
  colors: {
    bg: string; surface: string; text: string; muted: string; border: string;
    primary: string; onPrimary: string; accent: string; onAccent: string; price: string;
  };
  /** Fundo do banner principal (CSS). */
  hero: string;
  fonts: { heading: string; body: string };
  /** Família(s) do Google Fonts para carregar na página pública. */
  googleFonts: string;
  badgeShape: 'pill' | 'ribbon' | 'stamp';
  headline: string;
  subtitle: string;
}

const body = 'Nunito Sans';

export const CATALOG_THEMES: CatalogTheme[] = [
  {
    id: 'natal', name: 'Natal', ornaments: ['🎄', '❄️', '⭐', '🎁'],
    colors: { bg: '#fbf6ee', surface: '#ffffff', text: '#2b1a12', muted: '#7a6458', border: '#ead9c6', primary: '#b3152b', onPrimary: '#ffffff', accent: '#1f6b3a', onAccent: '#ffffff', price: '#b3152b' },
    hero: 'linear-gradient(135deg, #b3152b 0%, #7e0d1d 55%, #1f6b3a 100%)',
    fonts: { heading: 'Mountains of Christmas', body }, googleFonts: 'Mountains+of+Christmas:wght@700', badgeShape: 'ribbon',
    headline: 'Presentes que encantam', subtitle: 'Peças feitas à mão, sob medida para o seu Natal.',
  },
  {
    id: 'ano_novo', name: 'Ano Novo', ornaments: ['✨', '🥂', '🎆', '⭐'],
    colors: { bg: '#0f1424', surface: '#1a2138', text: '#f5f1e6', muted: '#b9b4a6', border: '#2c3552', primary: '#d4af37', onPrimary: '#1a1405', accent: '#f5f1e6', onAccent: '#0f1424', price: '#e8c766' },
    hero: 'linear-gradient(135deg, #0f1424 0%, #232c4d 60%, #d4af37 140%)',
    fonts: { heading: 'Playfair Display', body }, googleFonts: 'Playfair+Display:wght@700', badgeShape: 'stamp',
    headline: 'Comece o ano com estilo', subtitle: 'Seleção especial para celebrar novos começos.',
  },
  {
    id: 'carnaval', name: 'Carnaval', ornaments: ['🎭', '🎉', '🪅', '🎶'],
    colors: { bg: '#fff8ec', surface: '#ffffff', text: '#2a1640', muted: '#6c5a80', border: '#f2dcf0', primary: '#8b2fc9', onPrimary: '#ffffff', accent: '#ff9f1c', onAccent: '#2a1640', price: '#e0187a' },
    hero: 'linear-gradient(120deg, #8b2fc9 0%, #e0187a 45%, #ff9f1c 80%, #12b5a5 100%)',
    fonts: { heading: 'Bungee', body }, googleFonts: 'Bungee', badgeShape: 'pill',
    headline: 'É Carnaval!', subtitle: 'Cor, brilho e peças para a folia.',
  },
  {
    id: 'black_friday', name: 'Black Friday', ornaments: ['⚡', '🔥', '🏷️', '💥'],
    colors: { bg: '#0b0b0b', surface: '#171717', text: '#f4f4f4', muted: '#a3a3a3', border: '#2a2a2a', primary: '#ffd400', onPrimary: '#0b0b0b', accent: '#ff3b30', onAccent: '#ffffff', price: '#ffd400' },
    hero: 'linear-gradient(135deg, #0b0b0b 0%, #1c1c1c 60%, #ff3b30 160%)',
    fonts: { heading: 'Anton', body }, googleFonts: 'Anton', badgeShape: 'stamp',
    headline: 'BLACK FRIDAY', subtitle: 'Os melhores preços do ano, por tempo limitado.',
  },
  {
    id: 'dia_das_maes', name: 'Dia das Mães', ornaments: ['💐', '🌷', '💖', '🌸'],
    colors: { bg: '#fff5f7', surface: '#ffffff', text: '#4a2333', muted: '#8d6573', border: '#f6d9e1', primary: '#d94f7c', onPrimary: '#ffffff', accent: '#9b6bbf', onAccent: '#ffffff', price: '#c23c69' },
    hero: 'linear-gradient(135deg, #f7a6bd 0%, #d94f7c 55%, #9b6bbf 100%)',
    fonts: { heading: 'Dancing Script', body }, googleFonts: 'Dancing+Script:wght@700', badgeShape: 'pill',
    headline: 'Para a melhor mãe do mundo', subtitle: 'Presentes cheios de carinho e personalidade.',
  },
  {
    id: 'dia_dos_pais', name: 'Dia dos Pais', ornaments: ['👔', '🛠️', '🏆', '⚽'],
    colors: { bg: '#f3f5f7', surface: '#ffffff', text: '#16222e', muted: '#5d6b78', border: '#d9e0e6', primary: '#1d3a5c', onPrimary: '#ffffff', accent: '#c98a2b', onAccent: '#ffffff', price: '#1d3a5c' },
    hero: 'linear-gradient(135deg, #1d3a5c 0%, #2e5579 60%, #c98a2b 140%)',
    fonts: { heading: 'Oswald', body }, googleFonts: 'Oswald:wght@600', badgeShape: 'ribbon',
    headline: 'Para o seu herói', subtitle: 'Presentes criativos para todos os estilos de pai.',
  },
  {
    id: 'namorados', name: 'Dia dos Namorados', ornaments: ['❤️', '💌', '🌹', '💕'],
    colors: { bg: '#fff4f4', surface: '#ffffff', text: '#3d1418', muted: '#8a5a5f', border: '#f5d3d6', primary: '#c8102e', onPrimary: '#ffffff', accent: '#ff7a8a', onAccent: '#3d1418', price: '#c8102e' },
    hero: 'linear-gradient(135deg, #ff7a8a 0%, #c8102e 60%, #6e0a1a 100%)',
    fonts: { heading: 'Pacifico', body }, googleFonts: 'Pacifico', badgeShape: 'pill',
    headline: 'Amor em cada detalhe', subtitle: 'Presentes únicos para quem você ama.',
  },
  {
    id: 'pascoa', name: 'Páscoa', ornaments: ['🐰', '🥚', '🌼', '🍫'],
    colors: { bg: '#fffbf0', surface: '#ffffff', text: '#3b2a1a', muted: '#7d6a55', border: '#f1e4c8', primary: '#8a5a2b', onPrimary: '#ffffff', accent: '#8fc9a8', onAccent: '#203a2b', price: '#8a5a2b' },
    hero: 'linear-gradient(135deg, #ffd9a0 0%, #f6b6c9 45%, #b9e3cf 100%)',
    fonts: { heading: 'Baloo 2', body }, googleFonts: 'Baloo+2:wght@700', badgeShape: 'pill',
    headline: 'Feliz Páscoa!', subtitle: 'Peças fofas e criativas para a data mais doce.',
  },
  {
    id: 'criancas', name: 'Dia das Crianças', ornaments: ['🧸', '🚀', '🎈', '🦖'],
    colors: { bg: '#f2f9ff', surface: '#ffffff', text: '#18324a', muted: '#5b7287', border: '#d6e8f7', primary: '#ff6b35', onPrimary: '#ffffff', accent: '#2bb3f0', onAccent: '#ffffff', price: '#ff6b35' },
    hero: 'linear-gradient(120deg, #2bb3f0 0%, #6bd47a 45%, #ffd23f 75%, #ff6b35 100%)',
    fonts: { heading: 'Fredoka', body }, googleFonts: 'Fredoka:wght@600', badgeShape: 'pill',
    headline: 'Diversão garantida!', subtitle: 'Brinquedos e peças que fazem a alegria da criançada.',
  },
  {
    id: 'halloween', name: 'Halloween', ornaments: ['🎃', '🦇', '👻', '🕸️'],
    colors: { bg: '#15111c', surface: '#211a2b', text: '#f3ece0', muted: '#b3a7c0', border: '#352a44', primary: '#ff7518', onPrimary: '#15111c', accent: '#8e5cd9', onAccent: '#ffffff', price: '#ff9a4d' },
    hero: 'linear-gradient(135deg, #15111c 0%, #3b2457 55%, #ff7518 140%)',
    fonts: { heading: 'Creepster', body }, googleFonts: 'Creepster', badgeShape: 'stamp',
    headline: 'Doces ou travessuras?', subtitle: 'Peças assustadoramente incríveis.',
  },
  {
    id: 'verao', name: 'Liquidação de Verão', ornaments: ['☀️', '🌴', '🏖️', '🍉'],
    colors: { bg: '#fffaf0', surface: '#ffffff', text: '#173a45', muted: '#5f7c84', border: '#f2e3c4', primary: '#00a6b4', onPrimary: '#ffffff', accent: '#ff8a3d', onAccent: '#ffffff', price: '#e8590c' },
    hero: 'linear-gradient(135deg, #ffd166 0%, #ff8a3d 45%, #00a6b4 100%)',
    fonts: { heading: 'Righteous', body }, googleFonts: 'Righteous', badgeShape: 'stamp',
    headline: 'Liquidação de Verão', subtitle: 'Preços quentes por tempo limitado.',
  },
  {
    id: 'corporativo', name: 'Corporativo', ornaments: ['💼', '🏢', '📈', '🤝'],
    colors: { bg: '#f4f6f9', surface: '#ffffff', text: '#14213d', muted: '#5c6b82', border: '#dde3ec', primary: '#14213d', onPrimary: '#ffffff', accent: '#0f9d8a', onAccent: '#ffffff', price: '#14213d' },
    hero: 'linear-gradient(135deg, #14213d 0%, #1f3a68 60%, #0f9d8a 140%)',
    fonts: { heading: 'Montserrat', body: 'Inter' }, googleFonts: 'Montserrat:wght@700&family=Inter:wght@400;600;700', badgeShape: 'pill',
    headline: 'Brindes corporativos', subtitle: 'Presentes personalizados com a marca da sua empresa.',
  },
  {
    id: 'eventos', name: 'Eventos (aniversários, casamentos, shows)', ornaments: ['🎉', '💍', '🎂', '🎤'],
    colors: { bg: '#fffaf5', surface: '#ffffff', text: '#3a2a3f', muted: '#806b84', border: '#efe2ea', primary: '#b05c8a', onPrimary: '#ffffff', accent: '#d4a24c', onAccent: '#2b1d10', price: '#9c3f72' },
    hero: 'linear-gradient(135deg, #f3c9dc 0%, #b05c8a 50%, #d4a24c 110%)',
    fonts: { heading: 'Great Vibes', body }, googleFonts: 'Great+Vibes', badgeShape: 'ribbon',
    headline: 'Lembranças para o seu evento', subtitle: 'Aniversários, casamentos, chás e shows com peças únicas.',
  },
  {
    id: 'religioso', name: 'Itens Religiosos', ornaments: ['✝️', '🕊️', '🙏', '✨'],
    colors: { bg: '#fbf8f1', surface: '#ffffff', text: '#2f2a22', muted: '#7a7060', border: '#ebe3d2', primary: '#5a4a8a', onPrimary: '#ffffff', accent: '#c9a54a', onAccent: '#2f2a22', price: '#5a4a8a' },
    hero: 'linear-gradient(135deg, #e9e1f5 0%, #8b7bb8 50%, #c9a54a 120%)',
    fonts: { heading: 'Cormorant Garamond', body }, googleFonts: 'Cormorant+Garamond:wght@700', badgeShape: 'pill',
    headline: 'Fé em cada detalhe', subtitle: 'Imagens, terços, lembranças de batizado, crisma e primeira comunhão.',
  },
  {
    id: 'minimalista', name: 'Minimalista / Profissional', ornaments: [],
    colors: { bg: '#f7f7f5', surface: '#ffffff', text: '#1c1c1c', muted: '#6b6b6b', border: '#e4e4e0', primary: '#1c1c1c', onPrimary: '#ffffff', accent: '#0d6efd', onAccent: '#ffffff', price: '#1c1c1c' },
    hero: 'linear-gradient(135deg, #2b2b2b 0%, #4a4a4a 100%)',
    fonts: { heading: 'Inter', body: 'Inter' }, googleFonts: 'Inter:wght@400;600;700', badgeShape: 'pill',
    headline: 'Catálogo de produtos', subtitle: 'Peças impressas em 3D com acabamento profissional.',
  },
];

/* ---------------------------------------------------------------- layout próprio */
/** Fontes oferecidas no layout próprio (todas do Google Fonts). */
export const FONT_CHOICES: { name: string; family: string; kind: 'titulo' | 'texto' | 'ambos' }[] = [
  { name: 'Nunito Sans', family: 'Nunito+Sans:wght@400;600;700', kind: 'ambos' },
  { name: 'Inter', family: 'Inter:wght@400;600;700', kind: 'ambos' },
  { name: 'Poppins', family: 'Poppins:wght@400;600;700', kind: 'ambos' },
  { name: 'Montserrat', family: 'Montserrat:wght@400;600;700', kind: 'ambos' },
  { name: 'Lato', family: 'Lato:wght@400;700', kind: 'ambos' },
  { name: 'Quicksand', family: 'Quicksand:wght@500;700', kind: 'ambos' },
  { name: 'Playfair Display', family: 'Playfair+Display:wght@700', kind: 'titulo' },
  { name: 'Cormorant Garamond', family: 'Cormorant+Garamond:wght@700', kind: 'titulo' },
  { name: 'Oswald', family: 'Oswald:wght@600', kind: 'titulo' },
  { name: 'Anton', family: 'Anton', kind: 'titulo' },
  { name: 'Bebas Neue', family: 'Bebas+Neue', kind: 'titulo' },
  { name: 'Righteous', family: 'Righteous', kind: 'titulo' },
  { name: 'Fredoka', family: 'Fredoka:wght@600', kind: 'titulo' },
  { name: 'Baloo 2', family: 'Baloo+2:wght@700', kind: 'titulo' },
  { name: 'Pacifico', family: 'Pacifico', kind: 'titulo' },
  { name: 'Dancing Script', family: 'Dancing+Script:wght@700', kind: 'titulo' },
  { name: 'Great Vibes', family: 'Great+Vibes', kind: 'titulo' },
  { name: 'Lobster', family: 'Lobster', kind: 'titulo' },
  { name: 'Bungee', family: 'Bungee', kind: 'titulo' },
];

/** Ícones sugeridos para os enfeites do layout próprio. */
export const ICON_SUGGESTIONS = ['⭐', '✨', '❤️', '🎁', '🎉', '🌸', '🌿', '☀️', '❄️', '🎄', '🎃', '🐰', '💍', '🎂', '🕊️', '✝️', '💼', '🚀', '🧸', '🏆', '⚽', '🎮', '🐶', '🐱', '🦖', '🌈', '💡', '🔥', '🏷️', '🖨️'];

export interface CustomLayout {
  colors: CatalogTheme['colors'];
  /** Fundo da capa: degradê de duas cores. */
  heroFrom: string;
  heroTo: string;
  headingFont: string;
  bodyFont: string;
  ornaments: string[];
  badgeShape: CatalogTheme['badgeShape'];
  /** Imagem de fundo da página (opcional). */
  backgroundImage: string | null;
}

/** Ponto de partida do layout próprio: as cores e fontes de uma temática pronta. */
export function customFromTheme(t: CatalogTheme): CustomLayout {
  const stops = t.hero.match(/#[0-9a-f]{6}/gi) ?? [t.colors.primary, t.colors.accent];
  return {
    colors: { ...t.colors }, heroFrom: stops[0], heroTo: stops[stops.length - 1], headingFont: t.fonts.heading, bodyFont: t.fonts.body,
    ornaments: [...t.ornaments], badgeShape: t.badgeShape, backgroundImage: null,
  };
}

const PERSONALIZADO: CatalogTheme = {
  id: 'personalizado', name: 'Personalizado (meu layout)', ornaments: ['✨'],
  colors: { bg: '#f7f7f5', surface: '#ffffff', text: '#1c1c1c', muted: '#6b6b6b', border: '#e4e4e0', primary: '#ff7a00', onPrimary: '#ffffff', accent: '#0d6efd', onAccent: '#ffffff', price: '#ff7a00' },
  hero: 'linear-gradient(135deg, #ff7a00 0%, #0d6efd 100%)',
  fonts: { heading: 'Poppins', body: 'Nunito Sans' }, googleFonts: 'Poppins:wght@700', badgeShape: 'pill',
  headline: 'Meu catálogo', subtitle: 'Do meu jeito.',
};

export const themeOf = (id: string): CatalogTheme =>
  id === 'personalizado' ? PERSONALIZADO : CATALOG_THEMES.find((t) => t.id === id) ?? CATALOG_THEMES[CATALOG_THEMES.length - 1];

/** Visual final do catálogo: a temática, ou o layout próprio quando a temática é "Personalizado". */
export function resolveTheme(id: string, custom: CustomLayout | null | undefined): CatalogTheme & { backgroundImage: string | null } {
  if (id !== 'personalizado' || !custom) return { ...themeOf(id), backgroundImage: null };
  const fam = (name: string) => FONT_CHOICES.find((f) => f.name === name)?.family;
  return {
    ...PERSONALIZADO, colors: { ...custom.colors }, hero: `linear-gradient(135deg, ${custom.heroFrom} 0%, ${custom.heroTo} 100%)`,
    fonts: { heading: custom.headingFont, body: custom.bodyFont }, ornaments: custom.ornaments.slice(0, 4), badgeShape: custom.badgeShape,
    googleFonts: [fam(custom.headingFont), custom.bodyFont !== custom.headingFont ? fam(custom.bodyFont) : undefined].filter(Boolean).join('&family='),
    backgroundImage: custom.backgroundImage,
  };
}

/** Link do Google Fonts para a temática (fonte do título + texto). */
export function themeFontsHref(t: CatalogTheme): string {
  const fams = [t.googleFonts, t.fonts.body === 'Nunito Sans' ? 'Nunito+Sans:wght@400;600;700' : ''].filter(Boolean);
  return `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${f}`).join('&')}&display=swap`;
}
