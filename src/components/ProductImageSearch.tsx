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
      const query = `${productId} site:jiomart.com`;
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10`;

      const response = await fetch(url);
      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      if (data.items && data.items.length > 0) {
        const contextLink = data.items[0].image?.contextLink;
        if (contextLink) {
          setJiomartUrl(contextLink);
        }

        const imageUrls = data.items.map((item: any) => item.link).filter(Boolean);
        
        let allImages: string[] = [];
        if (imageUrls.length > 0) {
          allImages = await extractAllProductImages(imageUrls[0]);
          setExtractedImages(allImages);
        }
        
        saveToHistory(productId, contextLink);
        toast.success(`Found ${allImages.length} images`);
      } else {
        toast.error('No images found');
      }
    } catch (error) {
      console.error('Search error:', error);
      toast.error('Failed to search images');
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory]);

  const handleSearchById = useCallback(async (id: string) => {
    setProductId(id);
    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Google Search Engine ID not configured');
      return;
    }

    setLoading(true);
    setExtractedImages([]);
    setJiomartUrl('');
    
    try {
      const apiKey = getRandomApiKey();
      const query = `${id} site:jiomart.com`;
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10`;

      const response = await fetch(url);
      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      if (data.items && data.items.length > 0) {
        const contextLink = data.items[0].image?.contextLink;
        if (contextLink) {
          setJiomartUrl(contextLink);
        }

        const imageUrls = data.items.map((item: any) => item.link).filter(Boolean);
        
        let allImages: string[] = [];
        if (imageUrls.length > 0) {
          allImages = await extractAllProductImages(imageUrls[0]);
          setExtractedImages(allImages);
        }
        
        saveToHistory(id, contextLink);
        toast.success(`Found ${allImages.length} images`);
      } else {
        toast.error('No images found');
      }
    } catch (error) {
      console.error('Search error:', error);
      toast.error('Failed to search images');
    } finally {
      setLoading(false);
    }
  }, [saveToHistory]);

  // OCR Processing - Extract all text with positions from API
  const performOCR = async (imageBase64: string) => {
    setIsProcessingOCR(true);
    setTextOverlays([]);
    
    try {
      const base64Data = imageBase64.split(',')[1];
      
      const formData = new FormData();
      formData.append('base64Image', `data:image/jpeg;base64,${base64Data}`);
      formData.append('apikey', OCR_API_KEY);
      formData.append('OCREngine', '2');
      formData.append('detectOrientation', 'true');
      formData.append('scale', 'true');

      const response = await fetch(OCR_API_URL, {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();
      
      if (result.ParsedResults && result.ParsedResults.length > 0) {
        const parsedResult = result.ParsedResults[0];
        const lines = parsedResult.TextOverlay?.Lines || [];
        const overlayData = parsedResult.TextOverlay;
        
        if (!overlayData) {
          toast.error('No text overlay data found');
          return;
        }

        const overlays: TextOverlay[] = [];
        
        // Extract all text with positions from API's axis values
        lines.forEach((line: any) => {
          line.Words?.forEach((word: any) => {
            const text = word.WordText?.trim();
            if (!text) return;
            
            // Use API's bounding box coordinates directly
            const left = (word.Left / overlayData.Width) * 100;
            const top = (word.Top / overlayData.Height) * 100;
            const width = (word.Width / overlayData.Width) * 100;
            const height = (word.Height / overlayData.Height) * 100;
            
            overlays.push({
              text,
              left,
              top,
              width,
              height
            });
          });
        });
        
        setTextOverlays(overlays);
        toast.success(`Found ${overlays.length} text elements - Click any to search`);
      }
    } catch (error) {
      console.error('OCR Error:', error);
      toast.error('Failed to extract text');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  // Handle text click - perform search immediately
  const handleTextClick = (text: string) => {
    handleSearchById(text);
    toast.info(`Searching for: ${text}`);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const imageBase64 = event.target?.result as string;
      setCapturedImage(imageBase64);
      setShowCameraDialog(true);
      await performOCR(imageBase64);
    };
    reader.readAsDataURL(file);
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
      setShowCameraDialog(true);
    } catch (error) {
      toast.error('Failed to access camera');
    }
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0);
    
    const imageBase64 = canvas.toDataURL('image/jpeg', 0.8);
    setCapturedImage(imageBase64);
    
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    performOCR(imageBase64);
  };

  const closeCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    setShowCameraDialog(false);
    setCapturedImage(null);
    setTextOverlays([]);
  };

  const handleImageClick = (index: number) => {
    setSelectedImageIndex(index);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const closeImageViewer = () => {
    setSelectedImageIndex(null);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const handlePrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0) {
      setIsTransitioning(true);
      setTimeout(() => {
        setSelectedImageIndex(selectedImageIndex - 1);
        setZoom(1);
        setPosition({ x: 0, y: 0 });
        setIsTransitioning(false);
      }, 150);
    }
  };

  const handleNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
      setIsTransitioning(true);
      setTimeout(() => {
        setSelectedImageIndex(selectedImageIndex + 1);
        setZoom(1);
        setPosition({ x: 0, y: 0 });
        setIsTransitioning(false);
      }, 150);
    }
  };

  const handleZoomIn = () => {
    setZoom(prev => Math.min(prev + 0.5, 5));
  };

  const handleZoomOut = () => {
    setZoom(prev => {
      const newZoom = Math.max(prev - 0.5, 1);
      if (newZoom === 1) {
        setPosition({ x: 0, y: 0 });
      }
      return newZoom;
    });
  };

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
        y: e.clientY - dragStart.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const getTouchDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const distance = getTouchDistance(e.touches);
      touchStartRef.current = {
        distance,
        zoom,
        x: position.x,
        y: position.y,
      };
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        if (zoom === 1) {
          setZoom(2);
        } else {
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        }
      }
      lastTapRef.current = now;

      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: now,
      };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      const distance = getTouchDistance(e.touches);
      const scale = distance / touchStartRef.current.distance;
      const newZoom = Math.min(Math.max(touchStartRef.current.zoom * scale, 1), 5);
      setZoom(newZoom);

      if (newZoom === 1) {
        setPosition({ x: 0, y: 0 });
      }
    } else if (e.touches.length === 1 && zoom > 1) {
      const touch = e.touches[0];
      if (swipeStartRef.current) {
        setPosition({
          x: position.x + (touch.clientX - swipeStartRef.current.x),
          y: position.y + (touch.clientY - swipeStartRef.current.y),
        });
        swipeStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: swipeStartRef.current.time,
        };
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      touchStartRef.current = null;

      if (swipeStartRef.current && zoom === 1) {
        const deltaX = (e.changedTouches[0]?.clientX || 0) - swipeStartRef.current.x;
        const deltaTime = Date.now() - swipeStartRef.current.time;

        if (Math.abs(deltaX) > 50 && deltaTime < 300) {
          if (deltaX > 0) {
            handlePrevious();
          } else {
            handleNext();
          }
        }
      }

      swipeStartRef.current = null;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-muted/20 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            Product Image Search
          </h1>
          <p className="text-muted-foreground">Search for product images by ID or scan a product</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Input
              type="text"
              placeholder="Enter Product ID"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              className="pr-10 h-12 text-lg"
            />
            {productId && (
              <button
                onClick={() => setProductId('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
          
          <div className="flex gap-3">
            <Button onClick={handleSearch} disabled={loading} className="h-12 px-6">
              <Search className="w-5 h-5 mr-2" />
              Search
            </Button>

            <input
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
              className="hidden"
              id="image-upload"
            />
            <Button
              onClick={() => document.getElementById('image-upload')?.click()}
              variant="outline"
              className="h-12 px-6"
            >
              <Scan className="w-5 h-5 mr-2" />
              Scan
            </Button>

            <Button
              onClick={startCamera}
              variant="outline"
              className="h-12 px-6"
            >
              <Scan className="w-5 h-5" />
            </Button>

            <Button
              onClick={() => setShowHistoryDialog(true)}
              variant="outline"
              className="h-12 px-6"
            >
              <History className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {jiomartUrl && (
          <div className="flex items-center justify-between p-4 bg-primary/10 rounded-lg border border-primary/20">
            <p className="text-sm text-muted-foreground truncate flex-1">
              Found on: {jiomartUrl}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open(jiomartUrl, '_blank')}
              className="ml-2"
            >
              <ExternalLink className="w-4 h-4" />
            </Button>
          </div>
        )}

        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        {extractedImages.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {extractedImages.map((url, index) => (
              <div
                key={index}
                className="relative group cursor-pointer overflow-hidden rounded-lg border border-border hover:border-primary transition-all hover:shadow-lg"
                onClick={() => handleImageClick(index)}
              >
                <img
                  src={url}
                  alt={`Product ${index + 1}`}
                  className="w-full aspect-square object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              </div>
            ))}
          </div>
        )}

        {/* Image Viewer Dialog */}
        {selectedImageIndex !== null && (
          <Dialog open={true} onOpenChange={closeImageViewer}>
            <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 overflow-hidden">
              <div className="relative w-full h-[90vh] bg-black">
                <div
                  ref={imageRef}
                  className="w-full h-full overflow-hidden cursor-move select-none"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                >
                  <img
                    src={extractedImages[selectedImageIndex]}
                    alt="Full size"
                    className={`w-full h-full object-contain transition-all ${
                      isTransitioning ? 'duration-150' : 'duration-200'
                    }`}
                    style={{
                      transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                    }}
                    draggable={false}
                  />
                </div>

                <div className="absolute top-4 right-4 flex gap-2 bg-black/50 backdrop-blur-sm rounded-lg p-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleZoomIn}
                    disabled={zoom >= 5}
                    className="text-white hover:bg-white/20"
                  >
                    <ZoomIn className="w-5 h-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleZoomOut}
                    disabled={zoom <= 1}
                    className="text-white hover:bg-white/20"
                  >
                    <ZoomOut className="w-5 h-5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={closeImageViewer}
                    className="text-white hover:bg-white/20"
                  >
                    <X className="w-5 h-5" />
                  </Button>
                </div>

                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 bg-black/50 backdrop-blur-sm rounded-lg p-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handlePrevious}
                    disabled={selectedImageIndex === 0}
                    className="text-white hover:bg-white/20"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </Button>
                  <span className="text-white px-4 py-2">
                    {selectedImageIndex + 1} / {extractedImages.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNext}
                    disabled={selectedImageIndex === extractedImages.length - 1}
                    className="text-white hover:bg-white/20"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}

        {/* Camera/OCR Dialog */}
        <Dialog open={showCameraDialog} onOpenChange={closeCamera}>
          <DialogContent className="max-w-[95vw] max-h-[95vh] p-4">
            <DialogTitle>Scan Product</DialogTitle>
            <DialogDescription>
              {cameraStream ? 'Capture the product image' : 'Processing image...'}
            </DialogDescription>
            
            <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden">
              {cameraStream && !capturedImage && (
                <>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />
                  <Button
                    onClick={capturePhoto}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2"
                    size="lg"
                  >
                    Capture
                  </Button>
                </>
              )}

              {capturedImage && (
                <div className="relative w-full h-full">
                  <img
                    src={capturedImage}
                    alt="Captured"
                    className="w-full h-full object-contain"
                  />
                  
                  {/* Text Overlays - Clickable */}
                  {textOverlays.map((overlay, index) => (
                    <button
                      key={index}
                      className="absolute cursor-pointer bg-primary/20 hover:bg-primary/40 border-2 border-primary transition-all rounded-sm group"
                      style={{
                        left: `${overlay.left}%`,
                        top: `${overlay.top}%`,
                        width: `${overlay.width}%`,
                        height: `${overlay.height}%`,
                      }}
                      onClick={() => handleTextClick(overlay.text)}
                      title={`Click to search: ${overlay.text}`}
                    >
                      <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-primary-foreground bg-primary/90 px-1 whitespace-nowrap overflow-hidden opacity-0 group-hover:opacity-100 transition-opacity">
                        {overlay.text}
                      </span>
                    </button>
                  ))}

                  {isProcessingOCR && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <div className="text-white text-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-2"></div>
                        <p>Extracting text...</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <canvas ref={canvasRef} className="hidden" />
            </div>
          </DialogContent>
        </Dialog>

        {/* History Dialog */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent>
            <DialogTitle>Search History</DialogTitle>
            <DialogDescription>Your recent product searches</DialogDescription>
            
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {searchHistory.length === 0 ? (
                <p className="text-muted-foreground text-center py-4">No search history</p>
              ) : (
                searchHistory.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 hover:bg-muted/50 rounded-lg cursor-pointer"
                    onClick={() => {
                      handleSearchById(item.productId);
                      setShowHistoryDialog(false);
                    }}
                  >
                    <div className="flex-1">
                      <p className="font-medium">{item.productId}</p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(item.timestamp).toLocaleString()}
                      </p>
                    </div>
                    {item.jiomartUrl && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          window.open(item.jiomartUrl, '_blank');
                        }}
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
