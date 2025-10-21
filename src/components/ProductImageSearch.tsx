import { useState, useRef, useEffect } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, Scan, Camera } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { getRandomApiKey, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';
import { createWorker } from 'tesseract.js';

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
  const lastTapRef = useRef<number>(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

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

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 0.25, 5));
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

  const handleDoubleTap = (e: React.TouchEvent) => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300;
    
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      e.preventDefault();
      setIsTransitioning(true);
      if (zoom === 1) {
        // Zoom in to 2x
        setZoom(2);
      } else {
        // Zoom out to 1x
        setZoom(1);
        setPosition({ x: 0, y: 0 });
      }
      setTimeout(() => setIsTransitioning(false), 300);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
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
    } else if (e.touches.length === 1) {
      handleDoubleTap(e);
      // Track touch start for both navigation and panning
      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now()
      };
      if (zoom > 1) {
        // Start panning for zoomed images
        setDragStart({ x: e.touches[0].clientX - position.x, y: e.touches[0].clientY - position.y });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = distance / touchStartRef.current.distance;
      const newZoom = Math.min(Math.max(touchStartRef.current.zoom * scale, 0.5), 5);
      setZoom(newZoom);
    } else if (e.touches.length === 1 && zoom > 1 && swipeStartRef.current) {
      // Pan the zoomed image
      e.preventDefault();
      const newX = e.touches[0].clientX - dragStart.x;
      const newY = e.touches[0].clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
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
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      e.preventDefault();
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleMouseLeave = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (zoom === 1) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } // Use back camera on mobile
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setShowCameraDialog(true);
    } catch (error) {
      toast.error('Failed to access camera');
      console.error('Camera error:', error);
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setShowCameraDialog(false);
  };

  const captureAndProcessImage = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsProcessingOCR(true);
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    // Set canvas dimensions to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Draw current video frame to canvas
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Convert canvas to blob
    canvas.toBlob(async (blob) => {
      if (!blob) {
        toast.error('Failed to capture image');
        setIsProcessingOCR(false);
        return;
      }

      try {
        toast.info('Extracting text from image...');
        
        // Initialize Tesseract worker
        const worker = await createWorker('eng');
        
        // Perform OCR
        const { data: { text } } = await worker.recognize(blob);
        await worker.terminate();
        
        // Extract alphanumeric text (clean up the result)
        const cleanedText = text
          .replace(/[^a-zA-Z0-9\s]/g, '') // Remove special characters
          .trim()
          .split(/\s+/) // Split by whitespace
          .filter(word => word.length > 0) // Remove empty strings
          .join(' ');
        
        if (cleanedText) {
          setProductId(cleanedText);
          toast.success('Text extracted successfully!');
          stopCamera();
        } else {
          toast.error('No text found in image');
        }
      } catch (error) {
        toast.error('Failed to extract text');
        console.error('OCR error:', error);
      } finally {
        setIsProcessingOCR(false);
      }
    }, 'image/jpeg');
  };

  useEffect(() => {
    return () => {
      // Cleanup camera stream on unmount
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraStream]);

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
        <Button variant="outline" size="icon" onClick={startCamera} title="Scan text from camera">
          <Scan className="w-4 h-4" />
        </Button>
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
        <DialogContent className="max-w-full max-h-full w-screen h-screen p-0 bg-background/95 backdrop-blur border-0">
          <div className="sr-only">
            <DialogTitle>Product Image Viewer</DialogTitle>
            <DialogDescription>View and navigate product images</DialogDescription>
          </div>
          {selectedImageIndex !== null && (
            <div className="relative w-full h-screen flex items-center justify-center">
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
                  disabled={zoom >= 5}
                >
                  <ZoomIn className="w-5 h-5" />
                </Button>
              </div>

              {/* Previous Button */}
              {selectedImageIndex > 0 && (
                <div
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-10 cursor-pointer text-foreground/80 hover:text-foreground transition-colors"
                  onClick={goToPrevious}
                >
                  <ChevronLeft className="w-8 h-8" />
                </div>
              )}

              {/* Image */}
              <div 
                className="w-full h-full flex items-center justify-center"
                onClick={closeImage}
              >
                <div 
                  ref={imageRef}
                  className="relative w-full h-full flex items-center justify-center touch-none"
                  onClick={(e) => e.stopPropagation()}
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
                      transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`, 
                      transition: (isDragging || touchStartRef.current) && !isTransitioning ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                      cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                      transformOrigin: 'center center',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      touchAction: 'none'
                    }}
                    className="max-w-[80vw] max-h-[80vh] object-contain"
                    draggable={false}
                  />
                </div>
              </div>

              {/* Next Button */}
              {selectedImageIndex < extractedImages.length - 1 && (
                <div
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-10 cursor-pointer text-foreground/80 hover:text-foreground transition-colors"
                  onClick={goToNext}
                >
                  <ChevronRight className="w-8 h-8" />
                </div>
              )}

              {/* Image Counter */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-background/80 px-3 py-1 rounded-full text-sm">
                {selectedImageIndex + 1} / {extractedImages.length}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Camera Scanner Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="max-w-full max-h-full w-screen h-screen p-0 bg-background">
          <div className="sr-only">
            <DialogTitle>Scan Product Text</DialogTitle>
            <DialogDescription>Capture an image to extract product ID</DialogDescription>
          </div>
          <div className="relative w-full h-full flex flex-col">
            {/* Close Button */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 z-10 bg-background/80 hover:bg-background"
              onClick={stopCamera}
            >
              <X className="w-5 h-5" />
            </Button>

            {/* Video Preview */}
            <div className="flex-1 relative overflow-hidden bg-black">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full h-full object-cover"
              />
              <canvas ref={canvasRef} className="hidden" />
              
              {/* Scanning Frame Overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-[80%] h-[40%] border-2 border-primary rounded-lg shadow-lg">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-primary" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-primary" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-primary" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-primary" />
                </div>
              </div>
            </div>

            {/* Instructions and Capture Button */}
            <div className="p-6 bg-background space-y-4">
              <p className="text-center text-muted-foreground text-sm">
                Position the product text within the frame
              </p>
              <Button 
                onClick={captureAndProcessImage} 
                disabled={isProcessingOCR}
                className="w-full"
                size="lg"
              >
                <Camera className="w-5 h-5 mr-2" />
                {isProcessingOCR ? 'Processing...' : 'Capture & Extract Text'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
