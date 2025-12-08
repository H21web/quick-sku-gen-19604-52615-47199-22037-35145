const checkImageExists = async (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => resolve(false), 2500); // Increased timeout to 2500ms for better reliability
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

export const extractAllProductImages = async (firstImageUrl: string): Promise<string[]> => {
  const parts = parseJiomartUrl(firstImageUrl);

  if (!parts) {
    console.warn('Invalid JioMart URL format, returning original URL as fallback');
    const exists = await checkImageExists(firstImageUrl);
    return exists ? [firstImageUrl] : [];
  }

  const MAX_CHECKS = 15; // Increased for more coverage

  // Create all URLs to check in parallel
  const productUrls = Array.from({ length: MAX_CHECKS }, (_, i) =>
    buildImageUrl(parts, 'product-images', i)
  );
  const legalUrls = Array.from({ length: MAX_CHECKS }, (_, i) =>
    buildImageUrl(parts, 'legal-images', i)
  );

  // Check all images in parallel with fast timeout
  const allUrls = [...productUrls, ...legalUrls];
  const results = await Promise.all(
    allUrls.map(async (url) => ({
      url,
      exists: await checkImageExists(url)
    }))
  );

  const validImages = results.filter(r => r.exists).map(r => r.url);

  // Quick fallback: try incrementing pNumber if no images found
  if (validImages.length === 0) {
    const modifiedParts = { ...parts, pNumber: (parseInt(parts.pNumber) + 1).toString() };
    const fallbackUrls = Array.from({ length: 8 }, (_, i) =>
      buildImageUrl(modifiedParts, 'product-images', i)
    );
    const fallbackResults = await Promise.all(
      fallbackUrls.map(async (url) => ({ url, exists: await checkImageExists(url) }))
    );
    validImages.push(...fallbackResults.filter(r => r.exists).map(r => r.url));
  }

  // Ensure the original image is included if we found other images but missed the original for some reason
  if (validImages.length > 0 && !validImages.includes(firstImageUrl)) {
    const exists = await checkImageExists(firstImageUrl);
    if (exists) validImages.unshift(firstImageUrl);
  } else if (validImages.length === 0) {
    // If all extraction attempts failed, try to return just the original image
    const exists = await checkImageExists(firstImageUrl);
    if (exists) validImages.push(firstImageUrl);
  }

  return validImages;
};

export const preloadImages = (urls: string[], limit: number = 20) => {
  const urlsToPreload = limit > 0 ? urls.slice(0, limit) : urls;
  urlsToPreload.forEach((url) => {
    const img = new Image();
    img.src = url;
  });
};
