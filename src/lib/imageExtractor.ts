// ✅ ULTRA-OPTIMIZED PARALLEL IMAGE EXTRACTION - MILLISECOND SPEED

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
    }, 100); // Reduced to 100ms for faster rejection
    
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

// ✅ INTELLIGENT TYPE DETECTION - Only check the type that exists
const detectImageType = async (parts: ReturnType<typeof parseJiomartUrl>): Promise<'product-images' | 'legal-images'> => {
  if (!parts) return 'product-images';
  
  // Use the type from the first image URL
  return parts.imageType;
};

// ✅ ULTRA-FAST: Check only 16 images of detected type in parallel
export const extractAllProductImages = async (firstImageUrl: string): Promise<string[]> => {
  const startTime = performance.now();
  const parts = parseJiomartUrl(firstImageUrl);
  
  if (!parts) {
    console.error('Invalid JioMart URL format');
    return [];
  }

  const MAX_CHECKS = 16; // Check only 16 images
  
  // ✅ Detect image type (product or legal)
  const imageType = await detectImageType(parts);
  
  // ✅ Generate ONLY the relevant image type URLs
  const allUrls: string[] = [];
  
  // Only check the detected type (product-images OR legal-images)
  for (let i = 0; i < MAX_CHECKS; i++) {
    allUrls.push(buildImageUrl(parts, imageType, i));
  }
  
  // Optional: Try alternate pNumber only for first 5 images (faster fallback)
  const pNumberVariations = [
    parseInt(parts.pNumber) + 1,
    parseInt(parts.pNumber) - 1,
  ];
  
  for (const pNum of pNumberVariations) {
    const modifiedParts = { ...parts, pNumber: pNum.toString() };
    for (let i = 0; i < 5; i++) {
      allUrls.push(buildImageUrl(modifiedParts, imageType, i));
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

  // Remove duplicates and maintain order
  const uniqueImages = [...new Set(validImages)];
  
  const processingTime = ((performance.now() - startTime) / 1000).toFixed(3);
  console.log(`✅ Extracted ${uniqueImages.length} ${imageType} in ${processingTime}s`);
  
  return uniqueImages;
};

// ✅ Aggressive preload for instant display
export const preloadImages = (urls: string[], priority: number = 16) => {
  // Preload all images immediately
  urls.slice(0, priority).forEach((url, index) => {
    const img = new Image();
    img.src = url;
    
    // Set loading priority
    if (index < 4) {
      img.loading = 'eager'; // First 4 images load immediately
    } else {
      img.loading = 'lazy';
    }
  });
};

// ✅ Batch preload for even faster performance
export const batchPreloadImages = (urls: string[]) => {
  // Split into chunks for parallel processing
  const chunkSize = 4;
  const chunks = [];
  
  for (let i = 0; i < urls.length; i += chunkSize) {
    chunks.push(urls.slice(i, i + chunkSize));
  }
  
  // Load each chunk in parallel
  chunks.forEach((chunk, chunkIndex) => {
    setTimeout(() => {
      chunk.forEach(url => {
        const img = new Image();
        img.src = url;
      });
    }, chunkIndex * 50); // Stagger by 50ms per chunk
  });
};

// ✅ Clear cache when needed
export const clearImageCache = () => {
  imageExistsCache.clear();
  cacheTimestamps.clear();
};
