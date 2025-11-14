import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Scan, ExternalLink } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { getRandomApiKey, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';
import { createWorker, PSM, Worker } from 'tesseract.js';

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
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [extractedText, setExtractedText] = useState<string>('');
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [selectableTexts, setSelectableTexts] = useState<Array<{ text: string; isNumber: boolean }>>([]);
  const [jiomartUrl, setJiomartUrl] = useState<string>('');
  const [showIframe, setShowIframe] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ocrWorkerRef = useRef<Worker | null>(null);

  const handleSearch = useCallback(async () => {
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
    setJiomartUrl('');
    
    try {
      const apiKey = getRandomApiKey();
      const query = `site:jiomart.com ${productId}`;
      
      // Parallel search for both images and web results
      const [imageResponse, webResponse] = await Promise.all([
        fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=5&fields=items(link)`),
        fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1&fields=items(link)`)
      ]);

      if (!imageResponse.ok) {
        const errorData = await imageResponse.json();
        console.error('Google API error:', errorData);
        throw new Error(errorData.error?.message || 'Failed to fetch images');
      }

      const [imageData, webData] = await Promise.all([
        imageResponse.json(),
        webResponse.json()
      ]);
      
      // Extract JioMart product page URL
      if (webData.items && webData.items.length > 0) {
        const productUrl = webData.items[0].link;
        if (productUrl.includes('jiomart.com')) {
          setJiomartUrl(productUrl);
          setShowIframe(true);
        }
      }
      
      if (!imageData.items || imageData.items.length === 0) {
        toast.error('No images found for this product ID');
        return;
      }

      // Get all initial links
      const initialLinks: string[] = imageData.items.map((item: any) => item.link);
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
    } catch (error: any) {
      console.error('Search error:', error);
      toast.error(error.message || 'Failed to search. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [productId]);

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
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        } 
      });
      setCameraStream(stream);
      setShowCameraDialog(true);
      
      // Wait for dialog to mount then attach stream
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      }, 100);
    } catch (error) {
      toast.error('Camera access denied or not available');
      console.error('Camera error:', error);
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setShowCameraDialog(false);
    setCapturedImage(null);
  };

  const captureImage = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    // Set canvas size to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Draw video frame to canvas
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Convert to image
    const imageData = canvas.toDataURL('image/jpeg', 0.9);
    setCapturedImage(imageData);
    
    // Stop camera stream
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    // Auto-extract text immediately
    await extractTextFromImage(imageData);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setExtractedText('');
    setDetectedIDs([]);
    setSelectableTexts([]);
    startCamera();
  };

  // Initialize OCR worker once and reuse
  useEffect(() => {
    const initWorker = async () => {
      try {
        const worker = await createWorker('eng', 1, {
          logger: () => {}, // Disable logging for speed
        });
        ocrWorkerRef.current = worker;
      } catch (error) {
        console.error('Failed to initialize OCR worker:', error);
      }
    };
    
    initWorker();
    
    return () => {
      if (ocrWorkerRef.current) {
        ocrWorkerRef.current.terminate();
      }
    };
  }, []);

  // Pre-process image for better OCR
  const preprocessImage = (imageData: string): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        
        // Scale up for better recognition
        const scale = 2;
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        
        // Draw with enhanced contrast
        ctx.filter = 'contrast(1.5) brightness(1.1)';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        // Convert to grayscale for better OCR
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = data[i + 1] = data[i + 2] = gray;
        }
        ctx.putImageData(imageData, 0, 0);
        
        resolve(canvas.toDataURL('image/jpeg', 0.95));
      };
      img.src = imageData;
    });
  };

  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);
    
    try {
      // Pre-process image for better OCR
      const processedImage = await preprocessImage(imageData);
      
      // Use cached worker or create new one
      let worker = ocrWorkerRef.current;
      if (!worker) {
        worker = await createWorker('eng', 1, {
          logger: () => {},
        });
      }
      
      // Run multiple OCR passes in parallel for better accuracy
      const [sparseResult, autoResult] = await Promise.all([
        (async () => {
          await worker!.setParameters({
            tessedit_char_whitelist: '0123456789IDDesc:id ',
            tessedit_pageseg_mode: PSM.SPARSE_TEXT,
          });
          return await worker!.recognize(processedImage);
        })(),
        (async () => {
          await worker!.setParameters({
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
            tessedit_pageseg_mode: PSM.AUTO,
          });
          return await worker!.recognize(processedImage);
        })()
      ]);
      
      // Combine results
      const combinedText = `${sparseResult.data.text}\n${autoResult.data.text}`;
      console.log('Extracted text:', combinedText);
      setExtractedText(combinedText);
      
      // Parse text into selectable segments
      const words = combinedText.split(/\s+/).filter(w => w.trim().length > 0);
      const selectable = words.map(word => {
        const cleanWord = word.trim();
        const isLongNumber = /^\d{6,}$/.test(cleanWord);
        const hasDigits = /\d/.test(cleanWord);
        return {
          text: cleanWord,
          isNumber: isLongNumber || hasDigits
        };
      });
      
      setSelectableTexts(selectable);
      
      // Find primary IDs
      const lines = combinedText.split('\n');
      const foundIDs: string[] = [];
      
      for (const line of lines) {
        // Look for "ID:" patterns
        if (/ID/i.test(line)) {
          const idMatch = line.match(/ID\s*[:：]?\s*(\d+)/i);
          if (idMatch && idMatch[1]) {
            const digits = idMatch[1].replace(/\D/g, '');
            if (digits.length >= 6) {
              foundIDs.push(digits);
            }
          }
        }
        // Look for standalone long numbers
        const numberMatch = line.match(/\b(\d{6,})\b/);
        if (numberMatch && !foundIDs.includes(numberMatch[1])) {
          foundIDs.push(numberMatch[1]);
        }
      }
      
      const uniqueIDs = Array.from(new Set(foundIDs));
      setDetectedIDs(uniqueIDs);
      
      if (uniqueIDs.length === 0) {
        toast.info('No IDs detected. Tap any text to search.');
      } else {
        toast.success(`Detected ${uniqueIDs.length} ID(s)`);
      }
    } catch (error) {
      console.error('OCR error:', error);
      toast.error('Failed to extract text. Please try again.');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const useDetectedID = (id: string) => {
    setProductId(id);
    stopCamera();
    toast.success(`Searching for: ${id}`);
    // Trigger search automatically
    setTimeout(() => {
      handleSearch();
    }, 100);
  };

  const handleTextSelect = (text: string) => {
    // Clean the text - extract numbers if present
    const numbers = text.match(/\d+/g);
    const searchText = numbers ? numbers.join('') : text;
    
    setProductId(searchText);
    stopCamera();
    toast.success(`Searching for: ${searchText}`);
    // Auto-search
    setTimeout(() => {
      handleSearch();
    }, 100);
  };

  useEffect(() => {
    return () => {
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
        <Button 
          variant="outline" 
          size="icon" 
          onClick={startCamera} 
          title="Scan text from camera"
        >
          <Scan className="w-4 h-4" />
        </Button>
        <Button onClick={handleSearch} disabled={loading}>
          <Search className="w-4 h-4 mr-2" />
          {loading ? 'Finding...' : 'Find'}
        </Button>
      </div>

      {/* JioMart Product Page */}
      {jiomartUrl && showIframe && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Product Page</h3>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(jiomartUrl, '_blank')}
              >
                <ExternalLink className="w-4 h-4 mr-1" />
                Open
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowIframe(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
          <div className="relative w-full h-[500px] rounded-lg border border-border overflow-hidden bg-background">
            <iframe
              src={jiomartUrl}
              className="w-full h-full"
              title="JioMart Product Page"
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          </div>
        </div>
      )}

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

      {/* Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="max-w-full max-h-full w-screen h-screen p-0 bg-black">
          <div className="sr-only">
            <DialogTitle>Camera Scanner</DialogTitle>
            <DialogDescription>Capture product image for text extraction</DialogDescription>
          </div>
          
          <div className="relative w-full h-full">
            {/* Close Button */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4 z-20 bg-black/50 hover:bg-black/70 text-white"
              onClick={stopCamera}
            >
              <X className="w-5 h-5" />
            </Button>

            {!capturedImage ? (
              <>
                {/* Live Camera View */}
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />
                
                {/* Scanning Guide */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="relative w-[85%] max-w-md aspect-[3/2] border-2 border-primary/60 rounded-lg">
                    <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl" />
                    <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr" />
                    <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl" />
                    <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br" />
                  </div>
                </div>

                {/* Instructions */}
                <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
                  <p className="text-white text-center mb-4 text-sm">
                    Position product text within the frame
                  </p>
                  <Button 
                    onClick={captureImage}
                    className="w-full"
                    size="lg"
                  >
                    <Scan className="w-5 h-5 mr-2" />
                    Capture
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* Captured Image Preview */}
                <div className="relative w-full h-full">
                  <img 
                    src={capturedImage} 
                    alt="Captured" 
                    className="w-full h-full object-contain"
                  />
                  
                  {/* Processing Overlay */}
                  {isProcessingOCR && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="bg-background/90 backdrop-blur-sm rounded-lg p-4 flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground">Extracting text...</span>
                      </div>
                    </div>
                  )}

                  {/* Smart Text Selection - Google Lens style */}
                  {!isProcessingOCR && selectableTexts.length > 0 && (
                    <div className="absolute inset-0 p-4 overflow-auto pointer-events-none">
                      <div className="max-w-2xl mx-auto pointer-events-auto">
                        {/* Primary IDs at top */}
                        {detectedIDs.length > 0 && (
                          <div className="mb-4 space-y-2">
                            <div className="text-xs text-white/70 font-medium mb-1 px-2">Product IDs</div>
                            {detectedIDs.map((id, index) => (
                              <button
                                key={`id-${index}`}
                                onClick={() => useDetectedID(id)}
                                className="w-full bg-primary/95 hover:bg-primary text-primary-foreground rounded-lg px-4 py-3 text-base font-mono font-bold shadow-lg transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-between"
                              >
                                <span>{id}</span>
                                <Search className="w-4 h-4" />
                              </button>
                            ))}
                          </div>
                        )}
                        
                        {/* All selectable text */}
                        <div className="bg-black/60 backdrop-blur-sm rounded-lg p-3">
                          <div className="text-xs text-white/70 font-medium mb-2 px-1">Tap any text to search</div>
                          <div className="flex flex-wrap gap-2">
                            {selectableTexts.map((item, index) => (
                              <button
                                key={index}
                                onClick={() => handleTextSelect(item.text)}
                                className={`px-3 py-2 rounded-md text-sm font-medium transition-all hover:scale-105 active:scale-95 ${
                                  item.isNumber
                                    ? 'bg-primary/80 hover:bg-primary text-primary-foreground font-mono'
                                    : 'bg-white/20 hover:bg-white/30 text-white'
                                }`}
                              >
                                {item.text}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Actions */}
                {!isProcessingOCR && selectableTexts.length === 0 && (
                  <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent space-y-3">
                    <p className="text-white text-center text-sm mb-2">
                      No text detected. Try retaking with better lighting.
                    </p>
                    <Button 
                      onClick={retakePhoto}
                      variant="outline"
                      className="w-full bg-white/10 hover:bg-white/20 text-white border-white/30"
                      size="lg"
                    >
                      Retake Photo
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
