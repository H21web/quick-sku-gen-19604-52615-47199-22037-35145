const checkImageExists = async (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => resolve(false), 300);
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
    console.error('Invalid JioMart URL format');
    return [];
  }

  const MAX_CHECKS = 7;
  
  // Create all URLs to check in parallel
  const productUrls = Array.from({ length: MAX_CHECKS }, (_, i) => 
    buildImageUrl(parts, 'product-images', i)
  );
  const legalUrls = Array.from({ length: MAX_CHECKS }, (_, i) => 
    buildImageUrl(parts, 'legal-images', i)
  );

  // Check all images in parallel
  const [productResults, legalResults] = await Promise.all([
    Promise.all(productUrls.map(async (url) => ({
      url,
      exists: await checkImageExists(url)
    }))),
    Promise.all(legalUrls.map(async (url) => ({
      url,
      exists: await checkImageExists(url)
    })))
  ]);

  const validImages = [
    ...productResults.filter(r => r.exists).map(r => r.url),
    ...legalResults.filter(r => r.exists).map(r => r.url)
  ];

  // Fallback: try incrementing pNumber if no images found
  if (validImages.length === 0) {
    const modifiedParts = { ...parts, pNumber: (parseInt(parts.pNumber) + 1).toString() };
    const fallbackUrls = Array.from({ length: 5 }, (_, i) => 
      buildImageUrl(modifiedParts, 'product-images', i)
    );
    const fallbackResults = await Promise.all(
      fallbackUrls.map(async (url) => ({ url, exists: await checkImageExists(url) }))
    );
    validImages.push(...fallbackResults.filter(r => r.exists).map(r => r.url));
  }

  return validImages;
};
