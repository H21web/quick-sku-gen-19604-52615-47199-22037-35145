const checkImageExists = async (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => resolve(false), 4000); // Increased timeout to 4000ms for better reliability
    img.onload = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timeout);
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
  index: number
): string => {
  if (!parts) return '';

  return `${parts.baseUrl}/original/${parts.productId}/${parts.name}-${imageType}-${parts.productCode}-p${parts.pNumber}-${index}-${parts.timestamp}.jpg`;
};

export const extractAllProductImages = async (
  firstImageUrl: string,
  onImageFound?: (url: string) => void
): Promise<string[]> => {
  const parts = parseJiomartUrl(firstImageUrl);

  if (!parts) {
    console.warn('Invalid JioMart URL format, returning original URL as fallback');
    const exists = await checkImageExists(firstImageUrl);
    if (exists) {
      onImageFound?.(firstImageUrl);
      return [firstImageUrl];
    }
    return [];
  }

  // Strategy: Check high-probability indices first (0-5) for both types
  // This allows us to return the most important images faster if we were yielding results (though currently we return all at once,
  // the parallel execution is batched to avoid clogging network).
  // Actually, for speed, we want to fire mostly parallel but prioritize "product-images" which are usually the main ones.

  const BATCH_1_SIZE = 6;  // First 6 images (0-5) are most likely to exist
  const BATCH_2_SIZE = 10; // Next 10 images (6-15)

  // Helper to generate URLs for a range
  const generateUrls = (type: 'product-images' | 'legal-images', start: number, count: number) =>
    Array.from({ length: count }, (_, i) => buildImageUrl(parts, type, start + i));

  // Batch 1: High priority
  const priorityUrls = [
    ...generateUrls('product-images', 0, BATCH_1_SIZE),
    ...generateUrls('legal-images', 0, BATCH_1_SIZE)
  ];

  // Batch 2: Lower priority (extended check)
  const secondaryUrls = [
    ...generateUrls('product-images', BATCH_1_SIZE, BATCH_2_SIZE),
    ...generateUrls('legal-images', BATCH_1_SIZE, BATCH_2_SIZE)
  ];

  const checkAndNotify = async (url: string) => {
    const exists = await checkImageExists(url);
    if (exists) {
      onImageFound?.(url);
    }
    return { url, exists };
  };

  // Check priority URLs first
  const priorityResults = await Promise.all(
    priorityUrls.map(checkAndNotify)
  );

  let validImages = priorityResults.filter(r => r.exists).map(r => r.url);

  // If we found very few images in priority batch, or if we want to be thorough, check secondary.
  // To optimize speed/bandwidth, if we found a good amount (e.g. > 4) in priority, might skip secondary? 
  // User asked for "result speed". But let's check secondary in parallel but AFTER priority returns if we want "progressive" locally?
  // Since this function returns a generic Promise<string[]>, it must wait. 
  // TO IMPROVE SPEED: We will check ALL in parallel but with a short-circuit if the first batch fails fast? 
  // No, `checkImageExists` has a 4s timeout. 
  // Optimization: Fire ALL requests. `Promise.all` waits for slowest. 
  // Better Optimization: Fire priority. If we get enough, return? No, user wants ALL images usually.
  // But maybe we can run secondary checks with a shorter timeout if the network is detected slow? No easy way to detect.

  // Let's stick to parallel but maybe reduce the COUNT of secondary if priority was empty?
  // Actually, checking them all is safer for "completeness", but we can optimise by reducing the timeout for secondary checks?

  const secondaryResults = await Promise.all(
    secondaryUrls.map(checkAndNotify)
  );

  validImages = [...validImages, ...secondaryResults.filter(r => r.exists).map(r => r.url)];

  // Quick fallback: try incrementing pNumber if ABSOLUTELY no images found
  if (validImages.length === 0) {
    const modifiedParts = { ...parts, pNumber: (parseInt(parts.pNumber) + 1).toString() };
    const fallbackUrls = generateUrls('product-images', 0, 6);

    const fallbackResults = await Promise.all(
      fallbackUrls.map(checkAndNotify)
    );
    validImages.push(...fallbackResults.filter(r => r.exists).map(r => r.url));
  }

  // Ensure the original image is included only if we have NO other images.
  // If we found validImages (which are /original/), we don't want to prepend firstImageUrl
  // because it might be a low-quality version (e.g. 420x420) of one of the found images, causing duplicates.

  if (validImages.length === 0) {
    const exists = await checkImageExists(firstImageUrl);
    if (exists) {
      onImageFound?.(firstImageUrl);
      validImages.push(firstImageUrl);
    }
  }

  // Deduplicate strings just in case
  return Array.from(new Set(validImages));
};

export const preloadImages = (urls: string[], limit: number = 20) => {
  const urlsToPreload = limit > 0 ? urls.slice(0, limit) : urls;
  urlsToPreload.forEach((url) => {
    const img = new Image();
    img.src = url;
  });
};
