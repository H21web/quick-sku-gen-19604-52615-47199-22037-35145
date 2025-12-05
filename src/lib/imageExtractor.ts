// ✅ FIXED: Proper Promise timing + immediate cache warming
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
      cleanup();
      imageExistsCache.set(url, false);
      cacheTimestamps.set(url, now);
      resolve(false);
    }, 200); // Increased to 200ms for reliability
    
    // ✅ FIX: Define handlers BEFORE setting src
    const cleanup = () => {
      clearTimeout(timeout);
      img.onload = null;
      img.onerror = null;
    };
    
    img.onload = () => {
      cleanup();
      imageExistsCache.set(url, true);
      cacheTimestamps.set(url, now);
      resolve(true);
    };
    
    img.onerror = () => {
      cleanup();
      imageExistsCache.set(url, false);
      cacheTimestamps.set(url, now);
      resolve(false);
    };
    
    // ✅ Set src LAST to avoid race condition
    img.src = url;
  });
};

// ✅ IMPROVED: Batch processing with progress tracking
export const extractAllProductImages = async (
  firstImageUrl: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<string[]> => {
  const startTime = performance.now();
  const parts = parseJiomartUrl(firstImageUrl);
  
  if (!parts) {
    console.error('Invalid JioMart URL format');
    return [];
  }

  const MAX_CHECKS = 25;
  const BATCH_SIZE = 10; // Process in batches for better performance
  
  // Generate all URLs
  const allUrls: string[] = [];
  
  for (let i = 0; i < MAX_CHECKS; i++) {
    allUrls.push(buildImageUrl(parts, 'product-images', i));
  }
  
  for (let i = 0; i < MAX_CHECKS; i++) {
    allUrls.push(buildImageUrl(parts, 'legal-images', i));
  }
  
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

  // ✅ Process in batches to avoid overwhelming the browser
  const validImages: string[] = [];
  const totalUrls = allUrls.length;
  
  for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
    const batch = allUrls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (url) => ({
        url,
        exists: await checkImageExists(url)
      }))
    );
    
    const batchValid = results.filter(r => r.exists).map(r => r.url);
    validImages.push(...batchValid);
    
    // Report progress
    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, totalUrls), totalUrls);
    }
  }

  const uniqueImages = [...new Set(validImages)];
  
  const processingTime = ((performance.now() - startTime) / 1000).toFixed(3);
  console.log(`✅ Extracted ${uniqueImages.length} images in ${processingTime}s`);
  
  // ✅ Immediately preload first 5 images for instant display
  preloadImages(uniqueImages, 5);
  
  return uniqueImages;
};

// ✅ IMPROVED: Aggressive preloading
export const preloadImages = (urls: string[], priority: number = 12) => {
  urls.slice(0, priority).forEach((url, index) => {
    // Stagger slightly to avoid congestion
    setTimeout(() => {
      const img = new Image();
      img.src = url;
    }, index * 10);
  });
};
