export const scrapeSwiggyImages = async (url: string): Promise<string[]> => {
    try {
        // Use a reliable CORS proxy
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        console.log(`🌐 Fetching through proxy: ${proxyUrl}`);

        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Find all img tags
        const images = Array.from(doc.getElementsByTagName('img'));
        console.log(`📄 Found ${images.length} img tags on page`);

        const imageUrls = images
            .map(img => img.src || img.getAttribute('data-src') || '')
            .filter(src => src)
            .map(src => {
                // Handle relative URLs if necessary (though usually they are absolute CDN links)
                if (src.startsWith('//')) return `https:${src}`;
                if (src.startsWith('/')) {
                    try {
                        const urlObj = new URL(url);
                        return `${urlObj.origin}${src}`;
                    } catch {
                        return src;
                    }
                }
                return src;
            })
            .filter(src => {
                // Basic filtering for Swiggy/Instamart images or valid image URLs
                return (
                    src.includes('swiggy.com') ||
                    src.includes('instamart') ||
                    src.includes('cloudinary') ||
                    src.match(/\.(jpg|jpeg|png|webp)/i)
                );
            });

        // Deduplicate
        const uniqueImages = Array.from(new Set(imageUrls));

        console.log('🔗 Found Image Links on Page:');
        uniqueImages.forEach((img, index) => console.log(`   ${index + 1}. ${img}`));

        return uniqueImages;

    } catch (error) {
        console.error('❌ Error scraping Swiggy page:', error);
        return [];
    }
};
