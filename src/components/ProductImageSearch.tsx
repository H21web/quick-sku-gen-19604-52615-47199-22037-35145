import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Scan, ExternalLink, History } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { getRandomApiKey, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

// OCR.space API configuration
const OCR_API_KEY = 'K86120042088957';
const OCR_API_URL = 'https://api.ocr.space/parse/image';

interface OCRWord {
  WordText: string;
  Left: number;
  Top: number;
  Height: number;
  Width: number;
}

interface OCRLine {
  Words: OCRWord[];
  MaxHeight: number;
  MinTop: number;
}

interface TextOverlay {
  Lines: OCRLine[];
  HasOverlay: boolean;
  Message: string;
}

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
  const [jiomartUrl, setJiomartUrl] = useState<string>('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [textOverlays, setTextOverlays] = useState<OCRWord[]>([]);
  const [imageScale, setImageScale] = useState({ width: 1, height: 1 });
  const capturedImageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Load search history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      setSearchHistory(JSON.parse(savedHistory));
    }
  }, []);

  // Save search to history
  const saveToHistory = useCallback((productId: string, jiomartUrl?: string) => {
    const newHistoryItem: SearchHistoryItem = {
      id: Date.now().toString(),
      productId,
      timestamp: Date.now(),
      jiomartUrl
    };
    
    const updatedHistory = [newHistoryItem, ...searchHistory].slice(0, 20); // Keep last 20
    setSearchHistory(updatedHistory);
    localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
  }, [searchHistory]);

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
      
      // Parallel requests for faster results
      const [imageResponse, webResponse] = await Promise.all([
        fetch(
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10`
        ),
        fetch(
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1`
        )
      ]);

      // Handle image search results
      if (imageResponse.ok) {
        const imageData = await imageResponse.json();
        if (imageData.items && imageData.items.length > 0) {
          const imageUrls = await extractAllProductImages(imageData.items);
          setExtractedImages(imageUrls);
          if (imageUrls.length === 0) {
            toast.info('No images found for this product ID');
          }
        } else {
          toast.info('No images found for this product ID');
        }
      } else {
        throw new Error('Image search failed');
      }

      // Handle web search for JioMart URL
      if (webResponse.ok) {
        const webData = await webResponse.json();
        if (webData.items && webData.items.length > 0) {
          const jiomartLink = webData.items[0].link;
          setJiomartUrl(jiomartLink);
          saveToHistory(productId, jiomartLink);
        }
      } else {
        saveToHistory(productId);
      }
    } catch (error: any) {
      console.error('Search error:', error);
      if (error?.message?.includes('quota')) {
        toast.error('Daily API quota exceeded. Please try again tomorrow or add more API keys.');
      } else {
        toast.error('Failed to fetch images. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory]);

  const openImageModal = (index: number) => {
    setSelectedImageIndex(index);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const closeModal = () => {
    setSelectedImageIndex(null);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const goToPrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0) {
      setIsTransitioning(true);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setSelectedImageIndex(selectedImageIndex - 1);
      setTimeout(() => setIsTransitioning(false), 300);
    }
  };

  const goToNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
      setIsTransitioning(true);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setSelectedImageIndex(selectedImageIndex + 1);
      setTimeout(() => setIsTransitioning(false), 300);
    }
  };

  const zoomIn = () => {
    setZoom(prev => Math.min(prev + 0.25, 5));
  };

  const zoomOut = () => {
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

  useEffect(() => {
    if (selectedImageIndex !== null && zoom > 1) {
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [selectedImageIndex, zoom]);

  // Camera functions
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
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

  const capturePhoto = async () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);

    const imageData = canvas.toDataURL('image/png');
    setCapturedImage(imageData);
    
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
    setTextOverlays([]);
    capturedImageRef.current = null;
    startCamera();
  };

  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);
    setTextOverlays([]);
    
    try {
      // Convert base64 to blob
      const base64Data = imageData.split(',')[1];
      
      // Call OCR.space API with overlay
      const formData = new FormData();
      formData.append('base64Image', `data:image/png;base64,${base64Data}`);
      formData.append('apikey', OCR_API_KEY);
      formData.append('OCREngine', '2'); // Engine 2 for better accuracy
      formData.append('isOverlayRequired', 'true'); // Get word positions
      formData.append('detectOrientation', 'true');
      
      const response = await fetch(OCR_API_URL, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();
      
      if (result.OCRExitCode !== 1 || !result.ParsedResults?.[0]) {
        throw new Error(result.ErrorMessage || 'OCR failed');
      }

      const parsedResult = result.ParsedResults[0];
      const fullText = parsedResult.ParsedText || '';
      setExtractedText(fullText);

      // Process overlay data
      const overlay: TextOverlay = parsedResult.TextOverlay;
      if (overlay?.HasOverlay && overlay.Lines) {
        const allWords: OCRWord[] = [];
        
        overlay.Lines.forEach(line => {
          line.Words.forEach(word => {
            allWords.push(word);
          });
        });
        
        setTextOverlays(allWords);
      }

      // Extract IDs - strictly look for "ID :" pattern
      const idMatches: string[] = [];
      const idPattern = /ID\s*:?\s*(\d+)/gi;
      let match;
      while ((match = idPattern.exec(fullText)) !== null) {
        idMatches.push(match[1]);
      }
      
      // Fallback to 8-digit numbers if no "ID :" found
      if (idMatches.length === 0) {
        const numberPattern = /\b\d{8}\b/g;
        let numMatch;
        while ((numMatch = numberPattern.exec(fullText)) !== null) {
          idMatches.push(numMatch[0]);
        }
      }
      
      setDetectedIDs([...new Set(idMatches)]);
      
      // Auto-search if ID found
      if (idMatches.length > 0) {
        const firstID = idMatches[0];
        setProductId(firstID);
        toast.success(`ID detected: ${firstID}`);
        
        // Close camera dialog and search
        setShowCameraDialog(false);
        stopCamera();
        
        // Small delay to ensure UI updates
        setTimeout(async () => {
          await handleSearch();
        }, 100);
      } else {
        toast.info('Click on text overlay to select ID');
      }
    } catch (error) {
      console.error('OCR Error:', error);
      toast.error('Failed to extract text. Please try again.');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  useEffect(() => {
    if (showCameraDialog && !capturedImage) {
      startCamera();
    }
    return () => {
      stopCamera();
    };
  }, [showCameraDialog, capturedImage]);

  const handleHistoryClick = (item: SearchHistoryItem) => {
    setProductId(item.productId);
    setShowHistoryDialog(false);
    handleSearch();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4 sm:p-6 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-8 space-y-2">
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary via-primary/80 to-primary/60">
            Product Image Finder
          </h1>
          <p className="text-muted-foreground text-lg">
            Search for product images using JioMart product IDs
          </p>
        </div>

        <div className="bg-card rounded-2xl shadow-xl border border-border p-6 mb-8">
          <div className="flex gap-3 mb-4">
            <Input
              type="text"
              placeholder="Enter Product ID (e.g., 590688737)"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1 h-12 text-lg"
            />
            <Button 
              onClick={handleSearch} 
              disabled={loading}
              className="h-12 px-6 gap-2"
              size="lg"
            >
              {loading ? 'Searching...' : <><Search className="h-5 w-5" /> Search</>}
            </Button>
            <Button
              onClick={() => setShowCameraDialog(true)}
              variant="secondary"
              className="h-12 px-6"
              size="lg"
            >
              <Scan className="h-5 w-5" />
            </Button>
          </div>

          {jiomartUrl && (
            <div className="mt-4">
              <Button
                onClick={() => window.open(jiomartUrl, '_blank')}
                variant="outline"
                className="w-full gap-2"
              >
                <ExternalLink className="h-4 w-4" />
                Open Product Page
              </Button>
            </div>
          )}

          {loading && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mt-6">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="aspect-square rounded-lg" />
              ))}
            </div>
          )}

          {!loading && extractedImages.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4 mt-6">
              {extractedImages.map((imageUrl, index) => (
                <div
                  key={index}
                  className="group relative aspect-square rounded-lg overflow-hidden cursor-pointer border border-border hover:border-primary transition-all hover:shadow-lg"
                  onClick={() => openImageModal(index)}
                >
                  <img
                    src={imageUrl}
                    alt={`Product ${index + 1}`}
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                    loading="lazy"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Image Modal */}
      <Dialog open={selectedImageIndex !== null} onOpenChange={() => closeModal()}>
        <DialogContent className="max-w-7xl w-full h-[90vh] p-0 gap-0">
          <DialogTitle className="sr-only">Product Image Viewer</DialogTitle>
          <DialogDescription className="sr-only">
            View and zoom product image
          </DialogDescription>
          <div className="relative w-full h-full flex items-center justify-center bg-black/95">
            <button
              onClick={closeModal}
              className="absolute top-4 right-4 z-50 p-2 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
            >
              <X className="h-6 w-6 text-white" />
            </button>

            {selectedImageIndex !== null && selectedImageIndex > 0 && (
              <button
                onClick={goToPrevious}
                className="absolute left-4 z-50 p-3 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
              >
                <ChevronLeft className="h-8 w-8 text-white" />
              </button>
            )}

            {selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1 && (
              <button
                onClick={goToNext}
                className="absolute right-4 z-50 p-3 bg-black/50 hover:bg-black/70 rounded-full transition-colors"
              >
                <ChevronRight className="h-8 w-8 text-white" />
              </button>
            )}

            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 flex gap-2 bg-black/50 rounded-full p-2">
              <button
                onClick={zoomOut}
                disabled={zoom <= 0.5}
                className="p-2 hover:bg-white/10 rounded-full transition-colors disabled:opacity-50"
              >
                <ZoomOut className="h-5 w-5 text-white" />
              </button>
              <div className="px-4 py-2 text-white font-medium">
                {Math.round(zoom * 100)}%
              </div>
              <button
                onClick={zoomIn}
                disabled={zoom >= 5}
                className="p-2 hover:bg-white/10 rounded-full transition-colors disabled:opacity-50"
              >
                <ZoomIn className="h-5 w-5 text-white" />
              </button>
            </div>

            <div
              ref={imageRef}
              className="w-full h-full overflow-hidden cursor-move"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {selectedImageIndex !== null && (
                <img
                  src={extractedImages[selectedImageIndex]}
                  alt="Product"
                  className={`w-full h-full object-contain select-none ${isTransitioning ? 'transition-opacity duration-300' : ''}`}
                  style={{
                    transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                    transition: zoom > 1 ? 'none' : 'transform 0.3s ease-out',
                  }}
                  draggable="false"
                />
              )}
            </div>

            {selectedImageIndex !== null && (
              <div className="absolute top-4 left-4 bg-black/50 text-white px-4 py-2 rounded-full">
                {selectedImageIndex + 1} / {extractedImages.length}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => {
        setShowCameraDialog(open);
        if (!open) {
          stopCamera();
          setCapturedImage(null);
          setExtractedText('');
          setDetectedIDs([]);
          setTextOverlays([]);
        }
      }}>
        <DialogContent className="max-w-4xl">
          <DialogTitle>Scan Product ID</DialogTitle>
          <DialogDescription>
            Capture an image of the product ID to automatically extract it
          </DialogDescription>
          <div className="space-y-4">
            {!capturedImage ? (
              <>
                <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />
                </div>
                <Button onClick={capturePhoto} className="w-full" size="lg">
                  Capture Photo
                </Button>
              </>
            ) : (
              <>
                {capturedImage && (
                  <div className="space-y-4">
                    <div 
                      ref={capturedImageRef}
                      className="relative max-w-full mx-auto overflow-hidden rounded-lg border"
                    >
                      <img 
                        src={capturedImage} 
                        alt="Captured" 
                        className="max-w-full h-auto"
                        onLoad={(e) => {
                          const img = e.currentTarget;
                          capturedImageRef.current = img;
                          // Calculate scale for overlay positioning
                          const rect = img.getBoundingClientRect();
                          setImageScale({
                            width: rect.width / img.naturalWidth,
                            height: rect.height / img.naturalHeight
                          });
                        }}
                      />
                      {/* Text overlays - clickable regions */}
                      {textOverlays.map((word, idx) => (
                        <button
                          key={idx}
                          className="absolute border border-primary/50 bg-primary/10 hover:bg-primary/30 hover:border-primary transition-all cursor-pointer"
                          style={{
                            left: `${word.Left * imageScale.width}px`,
                            top: `${word.Top * imageScale.height}px`,
                            width: `${word.Width * imageScale.width}px`,
                            height: `${word.Height * imageScale.height}px`,
                          }}
                          onClick={() => {
                            const text = word.WordText;
                            // Extract numbers from clicked text
                            const numbers = text.match(/\d+/);
                            if (numbers) {
                              setProductId(numbers[0]);
                              toast.success(`Selected ID: ${numbers[0]}`);
                            } else {
                              toast.info(`Selected: ${text}`);
                            }
                          }}
                          title={word.WordText}
                        >
                          <span className="sr-only">{word.WordText}</span>
                        </button>
                      ))}
                    </div>

                    {extractedText && (
                      <div className="p-4 bg-muted rounded-lg">
                        <h3 className="font-semibold mb-2">Extracted Text:</h3>
                        <p className="text-sm whitespace-pre-wrap">{extractedText}</p>
                        {detectedIDs.length > 0 && (
                          <div className="mt-2 pt-2 border-t">
                            <p className="text-sm font-semibold">Detected IDs:</p>
                            <p className="text-sm text-primary">{detectedIDs.join(', ')}</p>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button onClick={retakePhoto} variant="outline" className="flex-1" size="lg">
                        Retake
                      </Button>
                      <Button 
                        onClick={() => extractTextFromImage(capturedImage!)}
                        className="flex-1"
                        size="lg"
                        disabled={isProcessingOCR}
                      >
                        {isProcessingOCR ? 'Scanning...' : 'Scan for ID'}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <canvas ref={canvasRef} className="hidden" />
        </DialogContent>
      </Dialog>

      {/* Search History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent>
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>
            Your recent product ID searches
          </DialogDescription>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {searchHistory.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No search history yet</p>
            ) : (
              searchHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                  onClick={() => handleHistoryClick(item)}
                >
                  <div className="flex-1">
                    <p className="font-medium">{item.productId}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(item.timestamp).toLocaleString()}
                    </p>
                  </div>
                  {item.jiomartUrl && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.open(item.jiomartUrl, '_blank');
                      }}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* History Button - Fixed Bottom Right */}
      <Button
        onClick={() => setShowHistoryDialog(true)}
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg"
        size="icon"
      >
        <History className="h-6 w-6" />
      </Button>
    </div>
  );
};