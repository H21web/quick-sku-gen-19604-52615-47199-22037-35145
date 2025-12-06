// lib/imageExtractor.ts

// Global cache to prevent re-checking known URLs (resets on refresh)
const imageExistsCache = new Map<string, boolean>();
const cacheExpiry = 10 * 60 * 1000; // 10 minutes cache
const cacheTimestamps = new Map<string, number>();

/**
 * ULTRA-FAST CHECK: Checks if a thumbnail exists (~3KB)
 * This avoids downloading the full ~2MB original image for validation.
 */
const checkImageExists = async (url: string): Promise<boolean> => {
  const now = Date.now();
  
  if (imageExistsCache.has(url)) {
    if (now - (cacheTimestamps.get(url) || 0) < cacheExpiry) {
      return imageExistsCache.get(url)!;
    }
  }

  return new Promise((resolve) => {
    const img = new Image();
    
    // Aggressive timeout: 400ms is plenty for a 3KB thumbnail even on 4G
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false); 
    }, 400);

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
  index: number,
  resolution: string
): string => {
  if (!parts) return '';
  return `${parts.baseUrl}/${resolution}/${parts.productId}/${parts.name}-${parts.imageType}-${parts.productCode}-p${parts.pNumber}-${index}-${parts.timestamp}.jpg`;
};

/**
 * Main Extraction Function
 * 1. Takes one valid image URL.
 * 2. Generates candidate URLs for indices 0-11.
 * 3. Checks the '150x150' thumbnail version of each (Speed Hack).
 * 4. Returns the 'original' resolution URL for confirmed images.
 */
export const extractAllProductImages = async (firstImageUrl: string): Promise<string[]> => {
  const parts = parseJiomartUrl(firstImageUrl);
  if (!parts) return [];

  // Check first 12 indices (0-11)
  const indicesToCheck = Array.from({ length: 12 }, (_, i) => i);
  
  // Create parallel checks for THUMBNAILS (150x150)
  const checkPromises = indicesToCheck.map(async (index) => {
    const thumbUrl = buildImageUrl(parts, index, '150x150');
    const exists = await checkImageExists(thumbUrl);
    
    if (exists) {
      // If thumbnail exists, return the ORIGINAL high-res URL
      return buildImageUrl(parts, index, 'original');
    }
    return null;
  });

  // Execute all checks simultaneously
  const results = await Promise.all(checkPromises);
  
  // Filter valid URLs
  const validImages = results.filter((url): url is string => url !== null);
  
  return [...new Set(validImages)]; // Remove duplicates
};

export const preloadImages = (urls: string[], count = 4) => {
  if (!urls?.length) return;
  urls.slice(0, count).forEach(url => {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'image';
    link.href = url;
    document.head.appendChild(link);
  });
};
