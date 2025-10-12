import { useState } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { getRandomApiKey, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

interface ImageResult {
  imageUrl: string;
  title: string;
}

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  const handleSearch = async () => {
    if (!productId.trim()) {
      toast.error('Please enter a product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Google Search Engine ID not configured. Please add it to config.ts');
      return;
    }

    setLoading(true);
    setExtractedImages([]);
    
    try {
      const apiKey = getRandomApiKey();
      const query = `site:jiomart.com ${productId}`;
      const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=5&fields=items(link)`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // Increased timeout
      const response = await fetch(searchUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Google API error:', errorData);
        throw new Error(errorData.error?.message || 'Failed to fetch images');
      }
      const data = await response.json();
      
      if (!data.items || data.items.length === 0) {
        toast.error('No images found for this product ID');
        return;
      }

      // Phase 1: show direct results immediately
      const initialLinks: string[] = data.items.map((item: any) => item.link);
      const initialUnique = Array.from(new Set(initialLinks));
      setExtractedImages(initialUnique);
      toast.success(`Found ${initialUnique.length} images (optimizing...)`);

      // Phase 2: refine JioMart images in background to gather all variants
      const jiomartLinks = initialUnique.filter((url) =>
        url.includes('jiomart.com/images/product')
      );

      Promise.allSettled(jiomartLinks.map((url) => extractAllProductImages(url)))
        .then((results) => {
          const more = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
          if (more.length > 0) {
            setExtractedImages((prev) => Array.from(new Set([...prev, ...more])));
          }
        })
        .catch((e) => console.error('Background extraction error:', e));
    } catch (error) {
      toast.error('Failed to fetch product images');
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  const openImage = (index: number) => {
    setSelectedImageIndex(index);
    setZoom(1);
  };

  const closeImage = () => {
    setSelectedImageIndex(null);
    setZoom(1);
  };

  const goToPrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0) {
      setSelectedImageIndex(selectedImageIndex - 1);
      setZoom(1);
    }
  };

  const goToNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
      setSelectedImageIndex(selectedImageIndex + 1);
      setZoom(1);
    }
  };

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 0.25, 3));
  };

  const handleZoomOut = () => {
    setZoom(prev => Math.max(prev - 0.25, 0.5));
  };

  return (
    <div className="space-y-4">
      {/* Search Section */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder="Enter product id"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1"
        />
        <Button onClick={handleSearch} disabled={loading}>
          <Search className="w-4 h-4 mr-2" />
          {loading ? 'Finding...' : 'Find'}
        </Button>
      </div>

      {/* Extracted Images Grid */}
      {extractedImages.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Product Images ({extractedImages.length})</h3>
          <div className="columns-2 sm:columns-3 md:columns-4 gap-3 [column-fill:_balance]">
            {extractedImages.map((url, index) => (
              <div
                key={url}
                className="mb-3 break-inside-avoid rounded-lg border border-border hover:border-primary transition-all overflow-hidden cursor-pointer group bg-muted"
                onClick={() => openImage(index)}
              >
                <img
                  src={url}
                  alt={`Product image ${index + 1}`}
                  className="w-full h-auto object-cover transition-all duration-300 group-hover:opacity-90"
                  loading="eager"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Image Viewer Dialog */}
      <Dialog open={selectedImageIndex !== null} onOpenChange={(open) => !open && closeImage()}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 bg-background/95 backdrop-blur">
          <div className="sr-only">
            <DialogTitle>Product Image Viewer</DialogTitle>
            <DialogDescription>View and navigate product images</DialogDescription>
          </div>
          {selectedImageIndex !== null && (
            <div className="relative w-full h-[90vh] flex items-center justify-center">
              {/* Close Button */}
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-4 right-4 z-10 bg-background/80 hover:bg-background"
                onClick={closeImage}
              >
                <X className="w-5 h-5" />
              </Button>

              {/* Zoom Controls */}
              <div className="absolute top-4 left-4 z-10 flex gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-background/80 hover:bg-background"
                  onClick={handleZoomOut}
                  disabled={zoom <= 0.5}
                >
                  <ZoomOut className="w-5 h-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-background/80 hover:bg-background"
                  onClick={handleZoomIn}
                  disabled={zoom >= 3}
                >
                  <ZoomIn className="w-5 h-5" />
                </Button>
              </div>

              {/* Previous Button */}
              {selectedImageIndex > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-10 bg-background/80 hover:bg-background"
                  onClick={goToPrevious}
                >
                  <ChevronLeft className="w-6 h-6" />
                </Button>
              )}

              {/* Image */}
              <div className="overflow-auto max-w-full max-h-full p-12">
                <img
                  src={extractedImages[selectedImageIndex]}
                  alt={`Product ${selectedImageIndex + 1}`}
                  style={{ transform: `scale(${zoom})`, transition: 'transform 0.2s' }}
                  className="max-w-full max-h-full object-contain"
                />
              </div>

              {/* Next Button */}
              {selectedImageIndex < extractedImages.length - 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-10 bg-background/80 hover:bg-background"
                  onClick={goToNext}
                >
                  <ChevronRight className="w-6 h-6" />
                </Button>
              )}

              {/* Image Counter */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-background/80 px-3 py-1 rounded-full text-sm">
                {selectedImageIndex + 1} / {extractedImages.length}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
