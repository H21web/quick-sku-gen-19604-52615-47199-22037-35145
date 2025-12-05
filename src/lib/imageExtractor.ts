// ✅ ULTRA-FAST PARALLEL IMAGE EXTRACTION - ALL IMAGES IN MILLISECONDS

// Global cache for maximum speed
const imageExistsCache = new Map<string, boolean>();
const cacheExpiry = 5 * 60 * 1000; // 5 minutes
const cacheTimestamps = new Map<string, number>();

// ✅ Ultra-fast image existence check with aggressive timeout
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
      img.src = ''; // Cancel loading
      imageExistsCache.set(url, false);
      cacheTimestamps.set(url, now);
      resolve(false);
    }, 100); // Ultra-fast 100ms timeout
    
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

// ✅ ULTRA-FAST: Check ALL images in parallel - MILLISECONDS!
export const extractAllProductImages = async (firstImageUrl: string): Promise<string[]> => {
  const startTime = performance.now();
  const parts = parseJiomartUrl(firstImageUrl);
  
  if (!parts) {
    console.error('Invalid JioMart URL format');
    return [];
  }

  // ✅ Smart sequential checking strategy
  const MAX_SEQUENTIAL = 30; // Check first 30 images sequentially
  
  // Generate URLs intelligently
  const allUrls: string[] = [];
  
  // Priority 1: Product images 0-29 (most common)
  for (let i = 0; i < MAX_SEQUENTIAL; i++) {
    allUrls.push(buildImageUrl(parts, 'product-images', i));
  }
  
  // Priority 2: Legal images 0-29
  for (let i = 0; i < MAX_SEQUENTIAL; i++) {
    allUrls.push(buildImageUrl(parts, 'legal-images', i));
  }

  // ✅ CHECK ALL URLS IN PARALLEL - Maximum concurrency!
  // Use Promise.all for true parallel execution
  const results = await Promise.all(
    allUrls.map(async (url) => {
      const exists = await checkImageExists(url);
      return exists ? url : null;
    })
  );

  // Filter valid images and remove nulls
  const validImages = results.filter((url): url is string => url !== null);
  
  // Remove duplicates (safety check)
  const uniqueImages = [...new Set(validImages)];
  
  const processingTime = ((performance.now() - startTime) / 1000).toFixed(3);
  console.log(`⚡ Extracted ${uniqueImages.length} images in ${processingTime}s from ${firstImageUrl}`);
  
  return uniqueImages;
};

// ✅ Preload images for instant display with priority
export const preloadImages = (urls: string[], priority: number = 15) => {
  // Use requestIdleCallback for better performance
  const preload = () => {
    urls.slice(0, priority).forEach((url, index) => {
      const img = new Image();
      // Stagger loading slightly to avoid overwhelming browser
      setTimeout(() => {
        img.src = url;
      }, index * 10);
    });
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(preload);
  } else {
    setTimeout(preload, 0);
  }
};

// ✅ Clear cache when needed
export const clearImageCache = () => {
  imageExistsCache.clear();
  cacheTimestamps.clear();
  console.log('🧹 Image cache cleared');
};

// ✅ Get cache stats for debugging
export const getCacheStats = () => {
  return {
    size: imageExistsCache.size,
    entries: Array.from(imageExistsCache.entries()).slice(0, 10)
  };
};
