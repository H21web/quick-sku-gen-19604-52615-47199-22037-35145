import { useState, useRef, useEffect } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, RotateCcw } from 'lucide-react';
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
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imageRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

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

      // Get all initial links
      const initialLinks: string[] = data.items.map((item: any) => item.link);
      const initialUnique = Array.from(new Set(initialLinks));
      
      // Extract all JioMart images upfront
      const jiomartLinks = initialUnique.filter((url) =>
        url.includes('jiomart.com/images/product')
      );

      toast.info('Extracting all product images...');

      // Wait for all extractions to complete
      const extractionResults = await Promise.allSettled(
        jiomartLinks.map((url) => extractAllProductImages(url))
      );
      
      const allExtractedImages = extractionResults.flatMap((r) => 
        (r.status === 'fulfilled' ? r.value : [])
      );

      // Only use high-quality extracted images, remove duplicates
      const highQualityImages = Array.from(new Set(allExtractedImages.filter(url => 
        url.includes('/original/')
      )));
      
      setExtractedImages(highQualityImages);
      toast.success(`Found ${highQualityImages.length} images`);
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
    setPosition({ x: 0, y: 0 });
  };

  const closeImage = () => {
    setSelectedImageIndex(null);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const goToPrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0) {
      setSelectedImageIndex(selectedImageIndex - 1);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  const goToNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
      setSelectedImageIndex(selectedImageIndex + 1);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  const resetZoom = () => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleDownload = async () => {
    if (selectedImageIndex === null) return;
    try {
      const imageUrl = extractedImages[selectedImageIndex];
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `product-image-${selectedImageIndex + 1}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success('Image downloaded');
    } catch (error) {
      toast.error('Failed to download image');
    }
  };

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 0.25, 3));
  };

  const handleZoomOut = () => {
    setZoom(prev => Math.max(prev - 0.25, 0.5));
  };

  // Touch event handlers for pinch-to-zoom
  const getTouchDistance = (touch1: React.Touch, touch2: React.Touch) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      touchStartRef.current = {
        distance,
        zoom,
        x: position.x,
        y: position.y
      };
    } else if (e.touches.length === 1 && zoom === 1) {
      // Track swipe start for navigation
      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now()
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = distance / touchStartRef.current.distance;
      const newZoom = Math.min(Math.max(touchStartRef.current.zoom * scale, 0.5), 3);
      setZoom(newZoom);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartRef.current && zoom === 1 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - swipeStartRef.current.x;
      const deltaY = touch.clientY - swipeStartRef.current.y;
      const deltaTime = Date.now() - swipeStartRef.current.time;
      
      // Check if it's a horizontal swipe (more horizontal than vertical)
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50 && deltaTime < 300) {
        if (deltaX > 0 && selectedImageIndex !== null && selectedImageIndex > 0) {
          // Swipe right - go to previous
          goToPrevious();
        } else if (deltaX < 0 && selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
          // Swipe left - go to next
          goToNext();
        }
      }
    }
    touchStartRef.current = null;
    swipeStartRef.current = null;
  };

  // Mouse drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  // Double click/tap to zoom
  const lastTapRef = useRef<number>(0);
  const handleImageClick = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const now = Date.now();
    const timeDiff = now - lastTapRef.current;
    
    if (timeDiff < 300 && timeDiff > 0) {
      // Double click/tap detected
      if (zoom === 1) {
        setZoom(2);
      } else {
        resetZoom();
      }
    }
    lastTapRef.current = now;
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedImageIndex === null) return;
      
      switch (e.key) {
        case 'ArrowLeft':
          goToPrevious();
          break;
        case 'ArrowRight':
          goToNext();
          break;
        case 'Escape':
          closeImage();
          break;
        case '+':
        case '=':
          handleZoomIn();
          break;
        case '-':
          handleZoomOut();
          break;
        case '0':
          resetZoom();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedImageIndex, zoom]);

  useEffect(() => {
    if (zoom === 1) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom]);

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
        <DialogContent className="max-w-full max-h-full w-screen h-screen p-0 bg-background/98 backdrop-blur-md border-0">
          <div className="sr-only">
            <DialogTitle>Product Image Viewer</DialogTitle>
            <DialogDescription>View and navigate product images with zoom and pan. Use arrow keys to navigate, +/- to zoom, 0 to reset, or Esc to close.</DialogDescription>
          </div>
          {selectedImageIndex !== null && (
            <div className="relative w-full h-screen flex items-center justify-center">
              {/* Top Controls */}
              <div className="absolute top-4 left-0 right-0 z-20 flex justify-between items-center px-4">
                {/* Zoom Controls */}
                <div className="flex gap-1 bg-background/90 backdrop-blur rounded-lg p-1 shadow-lg">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hover:bg-primary/10 transition-colors"
                    onClick={handleZoomOut}
                    disabled={zoom <= 0.5}
                    title="Zoom out (-)"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </Button>
                  <div className="px-3 py-2 text-sm font-medium min-w-[60px] text-center">
                    {Math.round(zoom * 100)}%
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hover:bg-primary/10 transition-colors"
                    onClick={handleZoomIn}
                    disabled={zoom >= 3}
                    title="Zoom in (+)"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </Button>
                  {zoom !== 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:bg-primary/10 transition-colors"
                      onClick={resetZoom}
                      title="Reset zoom (0)"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </Button>
                  )}
                </div>

                {/* Right Controls */}
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="bg-background/90 backdrop-blur hover:bg-background shadow-lg"
                    onClick={handleDownload}
                    title="Download image"
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="bg-background/90 backdrop-blur hover:bg-background shadow-lg"
                    onClick={closeImage}
                    title="Close (Esc)"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {/* Navigation Arrows */}
              {selectedImageIndex > 0 && (
                <button
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-background/90 backdrop-blur shadow-lg hover:bg-background hover:scale-110 transition-all duration-200 group"
                  onClick={goToPrevious}
                  title="Previous (←)"
                >
                  <ChevronLeft className="w-6 h-6 group-hover:scale-110 transition-transform" />
                </button>
              )}

              {/* Image Container */}
              <div 
                className="w-full h-full flex items-center justify-center p-20"
                onClick={closeImage}
              >
                <div 
                  ref={imageRef}
                  className="relative w-full h-full flex items-center justify-center touch-none overflow-hidden"
                  onClick={handleImageClick}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                >
                  <img
                    src={extractedImages[selectedImageIndex]}
                    alt={`Product ${selectedImageIndex + 1}`}
                    style={{ 
                      transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`, 
                      transition: (isDragging || touchStartRef.current) ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                      cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in',
                      transformOrigin: 'center center'
                    }}
                    className="max-w-full max-h-full object-contain select-none animate-fade-in"
                    draggable={false}
                  />
                  
                  {/* Zoom hint overlay */}
                  {zoom === 1 && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 hover:opacity-100 transition-opacity">
                      <div className="bg-background/80 backdrop-blur px-4 py-2 rounded-lg text-sm">
                        Double-click to zoom
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {selectedImageIndex < extractedImages.length - 1 && (
                <button
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-3 rounded-full bg-background/90 backdrop-blur shadow-lg hover:bg-background hover:scale-110 transition-all duration-200 group"
                  onClick={goToNext}
                  title="Next (→)"
                >
                  <ChevronRight className="w-6 h-6 group-hover:scale-110 transition-transform" />
                </button>
              )}

              {/* Bottom Info Bar */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-background/90 backdrop-blur shadow-lg px-4 py-2 rounded-full">
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium">
                    {selectedImageIndex + 1} / {extractedImages.length}
                  </span>
                  <div className="h-4 w-px bg-border" />
                  <span className="text-muted-foreground text-xs">
                    Use ← → to navigate • Double-click to zoom
                  </span>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
