export const scrapeSwiggyImages = async (url: string): Promise<string[]> => {
    try {
        console.log('🎯 Scraping product page:', url);

        // Use a reliable CORS proxy
        const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        console.log('🌐 Fetching through proxy...');

        const response = await fetch(proxyUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
        }

        const html = await response.text();
        console.log(`📄 Received HTML (${Math.round(html.length / 1024)}KB)`);

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Find all img tags
        const images = Array.from(doc.getElementsByTagName('img'));
        console.log(`🖼️ Found ${images.length} <img> tags on page`);

        // Extract all src and data-src attributes without filtering
        const imageUrls: string[] = [];

        images.forEach((img, index) => {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(' ')[0] || '';

            if (src) {
                // Handle relative URLs
                let fullUrl = src;
                if (src.startsWith('//')) {
                    fullUrl = `https:${src}`;
                } else if (src.startsWith('/')) {
                    try {
                        const urlObj = new URL(url);
                        fullUrl = `${urlObj.origin}${src}`;
                    } catch {
                        fullUrl = src;
                    }
                }

                imageUrls.push(fullUrl);
                console.log(`   ${index + 1}. ${fullUrl}`);
            }
        });

        // Deduplicate
        const uniqueImages = Array.from(new Set(imageUrls));

        console.log(`\n✅ Total unique images extracted: ${uniqueImages.length}`);
        console.log('🔗 All Image Links:');
        uniqueImages.forEach((img, index) => {
            console.log(`   ${index + 1}. ${img}`);
        });

        return uniqueImages;

    } catch (error) {
        console.error('❌ Error scraping Swiggy page:', error);
        return [];
    }
};
