
export interface ConfigItem {
  id: string;
  name: string;
  serialId: string;
}

export interface QuickSelectPreset {
  itemIndex: number;
  quantityIndex: number;
}

const parseItems = (envValue: string | undefined, fallback: ConfigItem[]): ConfigItem[] => {
  if (!envValue) return fallback;
  
  try {
    return envValue.split('|').map((item, index) => {
      const [name, serialId] = item.split(':');
      return {
        id: (index + 1).toString(),
        name: name.trim(),
        serialId: serialId.trim(),
      };
    });
  } catch (error) {
    console.error('Error parsing items from env:', error);
    return fallback;
  }
};

const parseQuickSelect = (envValue: string | undefined): QuickSelectPreset[] => {
  if (!envValue) return [
    { itemIndex: 0, quantityIndex: 3 },
    { itemIndex: 1, quantityIndex: 3 },
    { itemIndex: 0, quantityIndex: 1 },
    { itemIndex: 2, quantityIndex: 4 },
  ];
  
  try {
    return envValue.split('|').map(preset => {
      const [itemIndex, quantityIndex] = preset.split(',').map(Number);
      return { itemIndex, quantityIndex };
    });
  } catch (error) {
    console.error('Error parsing quick select from env:', error);
    return [
      { itemIndex: 0, quantityIndex: 3 },
      { itemIndex: 1, quantityIndex: 3 },
      { itemIndex: 0, quantityIndex: 1 },
      { itemIndex: 2, quantityIndex: 4 },
    ];
  }
};

const DEFAULT_ITEMS: ConfigItem[] = [
  { id: '1', name: 'Onion', serialId: '59019620' },
  { id: '2', name: 'Potato', serialId: '59019621' },
  { id: '3', name: 'Tomato', serialId: '59019622' },
];

const DEFAULT_QUANTITIES: ConfigItem[] = [
  { id: '1', name: '200g', serialId: '050201' },
  { id: '2', name: '500g', serialId: '050501' },
  { id: '3', name: '750g', serialId: '050751' },
  { id: '4', name: '1kg', serialId: '051001' },
  { id: '5', name: '2kg', serialId: '052001' },
  { id: '6', name: '3kg', serialId: '053001' },
  { id: '7', name: '5kg', serialId: '055001' },
];

export const ITEMS = parseItems(import.meta.env.VITE_ITEMS, DEFAULT_ITEMS);
export const QUANTITIES = parseItems(import.meta.env.VITE_QUANTITIES, DEFAULT_QUANTITIES);
export const QUICK_SELECT_PRESETS = parseQuickSelect(import.meta.env.VITE_QUICK_SELECT);

// Google Custom Search API configuration
const GOOGLE_API_KEYS = [
  'AIzaSyCUb-RrSjsScT_gfhmdyOMVp3ZHSSsai1U',
  'AIzaSyDVvxwYZzZAOLy5Cd3FMNrQKcxZxldsJCY',
  'AIzaSyBdRbGEG_nLOhaI1_RpNTN6kiwhEVcuxXo'
];

export const getRandomApiKey = () => {
  return GOOGLE_API_KEYS[Math.floor(Math.random() * GOOGLE_API_KEYS.length)];
};

export const GOOGLE_SEARCH_ENGINE_ID = '478b66fe0d0284d89';
