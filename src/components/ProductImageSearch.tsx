import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Scan, ExternalLink, History } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { getRandomApiKey, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_API_KEY = 'K86120042088957';
const OCR_API_URL = 'https://api.ocr.space/parse/image';

interface ImageResult {
  imageUrl: string;
  title: string;
}

interface SearchHistoryItem {
  id: string;
  productId: string;
  timestamp: number;
  jiomartUrl?: string;
}

interface TextOverlay {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  isNumeric: boolean;
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
  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [jiomartUrl, setJiomartUrl] = useState<string>('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Midnight cache refresh
  useEffect(() => {
    const checkMidnight = () => {
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() === 0) {
        localStorage.clear();
        toast.success('Cache refreshed at midnight');
      }
    };

    const interval = setInterval(checkMidnight, 60000);
    return () => clearInterval(interval);
  }, []);

  // Load search history
  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      setSearchHistory(JSON.parse(savedHistory));
    }
  }, []);

  const saveToHistory = useCallback((productId: string, jiomartUrl?: string) => {
    const newHistoryItem: SearchHistoryItem = {
      id: Date.now().toString(),
      productId,
      timestamp: Date.now(),
      jiomartUrl
    };
    
    const updatedHistory = [newHistoryItem, ...searchHistory].slice(0, 20);
    setSearchHistory(updatedHistory);
    localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
  }, [searchHistory]);

  const handleSearch = useCallback(async () => {
    if (!productId.trim()) {
      toast.error('Please enter a product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Google Search Engine ID not configured');
      return;
    }

    setLoading(true);
    setExtractedImages([]);
    setJiomartUrl('');
    
    try {
      const apiKey = getRandomApiKey();
      const query = `site:jiomart.com ${productId}`;
      
      const response = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=1`
      );
      
      if (!response.ok) throw new Error('Search failed');
      
      const data = await response.json();
      
      if (!data.items?.[0]) {
        toast.error('No images found');
        setLoading(false);
        return;
      }

      const firstImageUrl = data.items[0].link;
      const jiomartPageUrl = data.items[0].image.contextLink;
      
      setJiomartUrl(jiomartPageUrl || '');
      saveToHistory(productId, jiomartPageUrl);
      
      const allImages = await extractAllProductImages(firstImageUrl);
      
      if (allImages.length === 0) {
        toast.error('Failed to extract images');
      } else {
        setExtractedImages(allImages);
        toast.success(`Found ${allImages.length} images`);
      }
    } catch (error) {
      console.error('Search error:', error);
      toast.error('Search failed');
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory]);

  const compressImage = async (dataUrl: string, maxWidth = 1200, quality = 0.8): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = dataUrl;
    });
  };

  const performOCR = async (imageDataUrl: string) => {
    setIsProcessingOCR(true);
    setTextOverlays([]);
    
    try {
      const compressed = await compressImage(imageDataUrl, 1200, 0.8);
      const base64 = compressed.split(',')[1];

      const formData = new FormData();
      formData.append('base64Image', `data:image/jpeg;base64,${base64}`);
      formData.append('apikey', OCR_API_KEY);
      formData.append('OCREngine', '2');
      formData.append('detectOrientation', 'true');
      formData.append('scale', 'true');
      formData.append('isTable', 'false');

      const response = await fetch(OCR_API_URL, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (result.IsErroredOnProcessing) {
        throw new Error(result.ErrorMessage?.[0] || 'OCR failed');
      }

      const ocrData = result.ParsedResults?.[0];
      if (!ocrData) throw new Error('No OCR data');

      const overlays: TextOverlay[] = [];
      const lines = ocrData.TextOverlay?.Lines || [];
      
      lines.forEach((line: any) => {
        line.Words?.forEach((word: any) => {
          const text = word.WordText.trim();
          if (text) {
            const isNumeric = /^\d+$/.test(text) && text.length >= 6;
            overlays.push({
              text,
              left: word.Left,
              top: word.Top,
              width: word.Width,
              height: word.Height,
              isNumeric
            });
          }
        });
      });

      setTextOverlays(overlays);

      const fullText = ocrData.ParsedText || '';
      const idMatch = fullText.match(/ID\s*:?\s*(\d{8,})/i) || fullText.match(/(\d{8,})/);
      
      if (idMatch) {
        const detectedId = idMatch[1];
        setProductId(detectedId);
        toast.success(`Detected ID: ${detectedId}`);
        
        setTimeout(() => {
          setShowCameraDialog(false);
          stopCamera();
          handleSearch();
        }, 500);
      } else {
        toast.info('Click on a number to search');
      }

    } catch (error) {
      console.error('OCR error:', error);
      toast.error('OCR failed. Please try again.');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const openImageViewer = (index: number) => {
    setSelectedImageIndex(index);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const closeImageViewer = () => {
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
        setZoom(2);
      } else {
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
      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now()
      };
      if (zoom > 1) {
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
      
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50 && deltaTime < 300) {
        if (deltaX > 0 && selectedImageIndex !== null && selectedImageIndex > 0) {
          goToPrevious();
        } else if (deltaX < 0 && selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
          goToNext();
        }
      }
    }
    touchStartRef.current = null;
    swipeStartRef.current = null;
  };

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

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('Camera error:', error);
      toast.error('Failed to access camera');
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0);
    const imageDataUrl = canvas.toDataURL('image/jpeg', 0.9);
    setCapturedImage(imageDataUrl);
    
    performOCR(imageDataUrl);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setTextOverlays([]);
    startCamera();
  };

  const handleOpenCamera = () => {
    setShowCameraDialog(true);
    setCapturedImage(null);
    setTextOverlays([]);
    startCamera();
  };

  const handleCloseCamera = () => {
    setShowCameraDialog(false);
    setCapturedImage(null);
    setTextOverlays([]);
    stopCamera();
  };

  const handleTextClick = (text: string) => {
    if (/^\d{6,}$/.test(text)) {
      setProductId(text);
      setShowCameraDialog(false);
      stopCamera();
      setTimeout(() => handleSearch(), 100);
    }
  };

  const openHistoryDialog = () => {
    setShowHistoryDialog(true);
  };

  const closeHistoryDialog = () => {
    setShowHistoryDialog(false);
  };

  const loadFromHistory = (item: SearchHistoryItem) => {
    setProductId(item.productId);
    if (item.jiomartUrl) {
      setJiomartUrl(item.jiomartUrl);
    }
    closeHistoryDialog();
    handleSearch();
  };

  const clearHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem('searchHistory');
    toast.success('History cleared');
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  return (
    <div className="w-full max-w-4xl mx-auto p-6 space-y-6">
      <div className="space-y-4">
        <div className="flex gap-2">
          <Input
            type="text"
            placeholder="Enter product ID"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1"
          />
          <Button onClick={handleSearch} disabled={loading}>
            <Search className="h-4 w-4 mr-2" />
            Search
          </Button>
          <Button onClick={handleOpenCamera} variant="outline">
            <Scan className="h-4 w-4" />
          </Button>
        </div>

        {jiomartUrl && (
          <a
            href={jiomartUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-primary hover:underline"
          >
            <ExternalLink className="h-4 w-4" />
            View on JioMart
          </a>
        )}
      </div>

      {loading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))}
        </div>
      )}

      {extractedImages.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {extractedImages.map((imageUrl, index) => (
            <div
              key={index}
              className="relative aspect-square cursor-pointer group overflow-hidden rounded-lg border"
              onClick={() => openImageViewer(index)}
            >
              <img
                src={imageUrl}
                alt={`Product ${index + 1}`}
                className="w-full h-full object-cover transition-transform group-hover:scale-110"
              />
            </div>
          ))}
        </div>
      )}

      <Dialog open={selectedImageIndex !== null} onOpenChange={closeImageViewer}>
        <DialogContent className="max-w-4xl h-[90vh] p-0">
          <DialogTitle className="sr-only">Image Viewer</DialogTitle>
          <DialogDescription className="sr-only">View and navigate product images</DialogDescription>
          <div className="relative w-full h-full flex flex-col">
            <div className="absolute top-4 right-4 z-10 flex gap-2">
              <Button size="icon" variant="secondary" onClick={handleZoomIn}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="secondary" onClick={handleZoomOut}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Button size="icon" variant="secondary" onClick={closeImageViewer}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div
              ref={imageRef}
              className="flex-1 overflow-hidden cursor-move"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseLeave}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <div
                className={`w-full h-full flex items-center justify-center ${isTransitioning ? 'transition-transform duration-300' : ''}`}
                style={{
                  transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`
                }}
              >
                {selectedImageIndex !== null && (
                  <img
                    src={extractedImages[selectedImageIndex]}
                    alt={`Product ${selectedImageIndex + 1}`}
                    className="max-w-full max-h-full object-contain"
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-between p-4 bg-background border-t">
              <Button
                onClick={goToPrevious}
                disabled={selectedImageIndex === 0}
                variant="outline"
              >
                <ChevronLeft className="h-4 w-4 mr-2" />
                Previous
              </Button>
              <span className="text-sm">
                {selectedImageIndex !== null && `${selectedImageIndex + 1} / ${extractedImages.length}`}
              </span>
              <Button
                onClick={goToNext}
                disabled={selectedImageIndex === extractedImages.length - 1}
                variant="outline"
              >
                Next
                <ChevronRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showCameraDialog} onOpenChange={handleCloseCamera}>
        <DialogContent className="max-w-3xl">
          <DialogTitle>Scan Product ID</DialogTitle>
          <DialogDescription>Capture an image to extract the product ID</DialogDescription>
          <div className="space-y-4">
            {!capturedImage ? (
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />
              </div>
            ) : (
              <div className="relative">
                <img
                  src={capturedImage}
                  alt="Captured"
                  className="w-full rounded-lg"
                />
                {textOverlays.map((overlay, idx) => (
                  <div
                    key={idx}
                    className={`absolute border-2 cursor-pointer transition-colors ${
                      overlay.isNumeric
                        ? 'border-primary bg-primary/20 hover:bg-primary/40'
                        : 'border-muted bg-muted/20 hover:bg-muted/40'
                    }`}
                    style={{
                      left: `${overlay.left}px`,
                      top: `${overlay.top}px`,
                      width: `${overlay.width}px`,
                      height: `${overlay.height}px`,
                    }}
                    onClick={() => handleTextClick(overlay.text)}
                    title={`Click to search: ${overlay.text}`}
                  >
                    <span className="text-xs font-bold text-foreground px-1 bg-background/80 rounded">
                      {overlay.text}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              {!capturedImage ? (
                <>
                  <Button onClick={capturePhoto} className="flex-1">
                    Capture Photo
                  </Button>
                  <Button onClick={handleCloseCamera} variant="outline">
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button onClick={retakePhoto} variant="outline" className="flex-1">
                    Retake
                  </Button>
                  <Button onClick={handleCloseCamera} variant="outline">
                    Close
                  </Button>
                </>
              )}
            </div>

            {isProcessingOCR && (
              <div className="text-center text-sm text-muted-foreground">
                Processing image...
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showHistoryDialog} onOpenChange={closeHistoryDialog}>
        <DialogContent>
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>Recent product searches</DialogDescription>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {searchHistory.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No search history</p>
            ) : (
              <>
                {searchHistory.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent cursor-pointer"
                    onClick={() => loadFromHistory(item)}
                  >
                    <div>
                      <p className="font-medium">{item.productId}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(item.timestamp).toLocaleString()}
                      </p>
                    </div>
                    {item.jiomartUrl && (
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                ))}
                <Button onClick={clearHistory} variant="outline" className="w-full">
                  Clear History
                </Button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Button
        onClick={openHistoryDialog}
        className="fixed bottom-6 right-6 rounded-full h-14 w-14 shadow-lg"
        size="icon"
      >
        <History className="h-6 w-6" />
      </Button>
    </div>
  );
};
