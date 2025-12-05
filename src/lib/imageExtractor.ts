// ✅ ULTRA-FAST PARALLEL IMAGE EXTRACTION - ALL IMAGES AT ONCE

// Global cache for maximum speed
const imageExistsCache = new Map<string, boolean>();
const cacheExpiry = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

const checkImageExists = async (url: string): Promise<boolean> => {
  const now = Date.now();
  
  // Check cache first
  if (imageExistsCache.has(url)) {
    const cacheTime = cacheTimestamps.get(url) || 0;
    if (now - cacheTime < cacheExpiry) {
      return imageExistsCache.get(url)!;
    }
  }

  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => {
      imageExistsCache.set(url, false);
      cacheTimestamps.set(url, now);
      resolve(false);
    }, 150); // Ultra-fast 150ms timeout
    
    img.onload = () => {
      clearTimeout(timeout);
      imageExistsCache.set(url, true);
      cacheTimestamps.set(url, now);
      resolve(true);
    };
    
    img.onerror = () => {
      clearTimeout(timeout);
      imageExistsCache.set(url, false);
      cacheTimestamps.set(url, now);
      resolve(false);
    };
    
    img.src = url;
  });
};

const parseJiomartUrl = (url: string) => {
  const regex = /https:\/\/www\.jiomart\.com\/images\/product\/(\d+x\d+|original)\/(\d+)\/([^\/]+)-(product-images|legal-images)-([^-]+)-p(\d+)-(\d+)-(\d+)\.jpg/;
  const match = url.match(regex);
  
  if (!match) return null;
  
  return {
    baseUrl: 'https://www.jiomart.com/images/product',
    resolution: match[1],
    productId: match[2],
    name: match[3],
    imageType: match[4] as 'product-images' | 'legal-images',
    productCode: match[5],
    pNumber: match[6],
    index: parseInt(match[7]),
    timestamp: match[8]
  };
};

const buildImageUrl = (
  parts: ReturnType<typeof parseJiomartUrl>,
  imageType: 'product-images' | 'legal-images',
  index: number,
  resolution: string = 'original'
): string => {
  if (!parts) return '';
  
  return `${parts.baseUrl}/${resolution}/${parts.productId}/${parts.name}-${imageType}-${parts.productCode}-p${parts.pNumber}-${index}-${parts.timestamp}.jpg`;
};

// ✅ ULTRA-FAST: Check ALL images in parallel
export const extractAllProductImages = async (firstImageUrl: string): Promise<string[]> => {
  const startTime = performance.now();
  const parts = parseJiomartUrl(firstImageUrl);
  
  if (!parts) {
    console.error('Invalid JioMart URL format');
    return [];
  }

  const MAX_CHECKS = 25; // Check up to 25 images
  
  // ✅ Generate ALL possible URLs at once
  const allUrls: string[] = [];
  
  // Product images (0-24)
  for (let i = 0; i < MAX_CHECKS; i++) {
    allUrls.push(buildImageUrl(parts, 'product-images', i));
  }
  
  // Legal images (0-24)
  for (let i = 0; i < MAX_CHECKS; i++) {
    allUrls.push(buildImageUrl(parts, 'legal-images', i));
  }
  
  // Fallback: Try pNumber variations for first 10 images
  const pNumberVariations = [
    parseInt(parts.pNumber) + 1,
    parseInt(parts.pNumber) - 1,
  ];
  
  for (const pNum of pNumberVariations) {
    const modifiedParts = { ...parts, pNumber: pNum.toString() };
    for (let i = 0; i < 10; i++) {
      allUrls.push(buildImageUrl(modifiedParts, 'product-images', i));
      allUrls.push(buildImageUrl(modifiedParts, 'legal-images', i));
    }
  }

  // ✅ CHECK ALL URLS IN PARALLEL - Maximum speed!
  const results = await Promise.all(
    allUrls.map(async (url) => ({
      url,
      exists: await checkImageExists(url)
    }))
  );

  // Filter valid images
  const validImages = results
    .filter(r => r.exists)
    .map(r => r.url);

  // Remove duplicates
  const uniqueImages = [...new Set(validImages)];
  
  const processingTime = ((performance.now() - startTime) / 1000).toFixed(3);
  console.log(`✅ Extracted ${uniqueImages.length} images in ${processingTime}s from ${firstImageUrl}`);
  
  return uniqueImages;
};

// ✅ Preload images for instant display
export const preloadImages = (urls: string[], priority: number = 12) => {
  urls.slice(0, priority).forEach(url => {
    const img = new Image();
    img.src = url;
  });
};

// ✅ Clear cache when needed
export const clearImageCache = () => {
  imageExistsCache.clear();
  cacheTimestamps.clear();
};
