import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Scan, ExternalLink, History } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { GOOGLE_API_KEYS, GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_SPACE_API_KEY = 'K86120042088957';

interface SearchHistoryItem {
  id: string;
  productId: string;
  timestamp: number;
  jiomartUrl?: string;
  thumbnail?: string;
}

// API Key rotation logic - outside component to avoid closure issues
let apiKeyIndex = 0;
const getNextApiKey = (): string => {
  const key = GOOGLE_API_KEYS[apiKeyIndex % GOOGLE_API_KEYS.length];
  apiKeyIndex++;
  return key;
};

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [selectableTexts, setSelectableTexts] = useState<Array<{ text: string; isNumber: boolean }>>([]);
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);

  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const touchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef(0);

  // Load search history
  useEffect(() => {
    const saved = localStorage.getItem('searchHistory');
    if (saved) {
      try {
        setSearchHistory(JSON.parse(saved));
      } catch {
        localStorage.removeItem('searchHistory');
      }
    }
  }, []);

  // Save to history
  const saveToHistory = useCallback((id: string, url?: string, thumb?: string) => {
    setSearchHistory(prev => {
      const filtered = prev.filter(item => item.productId !== id);
      const newItem: SearchHistoryItem = {
        id: Date.now().toString(),
        productId: id,
        timestamp: Date.now(),
        jiomartUrl: url,
        thumbnail: thumb
      };
      const updated = [newItem, ...filtered].slice(0, 20);
      localStorage.setItem('searchHistory', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Image load handler
  const handleImageLoad = useCallback((url: string) => {
    setLoadedImages(prev => new Set(prev).add(url));
  }, []);

  // Search with API key rotation
  const handleSearch = useCallback(async (searchId?: string) => {
    const id = searchId || productId.trim();
    if (!id) {
      toast.error('Please enter a product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Search Engine ID not configured');
      return;
    }

    const startTime = performance.now();
    setLoading(true);
    setExtractedImages([]);
    setLoadedImages(new Set());
    setJiomartUrl('');
    setSearchTime(null);

    try {
      const query = `site:jiomart.com ${id}`;
      const apiKey = getNextApiKey();

      // Fetch image and web results in parallel
      const [imageRes, webRes] = await Promise.all([
        fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10`),
        fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1`)
      ]);

      if (!imageRes.ok || !webRes.ok) {
        // Try with next API key
        const nextKey = getNextApiKey();
        const [retryImageRes, retryWebRes] = await Promise.all([
          fetch(`https://www.googleapis.com/customsearch/v1?key=${nextKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10`),
          fetch(`https://www.googleapis.com/customsearch/v1?key=${nextKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1`)
        ]);

        if (!retryImageRes.ok) {
          throw new Error('Search API failed');
        }

        const [imageData, webData] = await Promise.all([retryImageRes.json(), retryWebRes.json()]);
        await processSearchResults(imageData, webData, id, startTime);
        return;
      }

      const [imageData, webData] = await Promise.all([imageRes.json(), webRes.json()]);
      await processSearchResults(imageData, webData, id, startTime);

    } catch (error: any) {
      console.error('Search error:', error);
      toast.error(error.message || 'Search failed');
      setSearchTime((performance.now() - startTime) / 1000);
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory]);

  // Process search results
  const processSearchResults = async (imageData: any, webData: any, id: string, startTime: number) => {
    // Get JioMart URL
    let foundUrl = '';
    if (webData.items?.[0]?.link?.includes('jiomart.com')) {
      foundUrl = webData.items[0].link;
      setJiomartUrl(foundUrl);
    }

    if (!imageData.items?.length) {
      toast.error('No images found');
      saveToHistory(id, foundUrl);
      setSearchTime((performance.now() - startTime) / 1000);
      return;
    }

    // Get unique JioMart image URLs
    const jiomartLinks = [...new Set(
      imageData.items
        .map((item: any) => item.link)
        .filter((url: string) => url?.includes('jiomart.com/images/product'))
    )] as string[];

    if (!jiomartLinks.length) {
      toast.error('No product images found');
      saveToHistory(id, foundUrl);
      setSearchTime((performance.now() - startTime) / 1000);
      return;
    }

    // Extract all images from found URLs
    const allImages: string[] = [];
    const results = await Promise.allSettled(
      jiomartLinks.map(url =>
        Promise.race([
          extractAllProductImages(url),
          new Promise<string[]>((_, reject) => setTimeout(() => reject('timeout'), 5000))
        ])
      )
    );

    results.forEach(result => {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        allImages.push(...result.value);
      }
    });

    // Remove duplicates and sort (original first)
    const uniqueImages = [...new Set(allImages)];
    const sorted = [
      ...uniqueImages.filter(url => url.includes('/original/')),
      ...uniqueImages.filter(url => !url.includes('/original/'))
    ];

    if (!sorted.length) {
      toast.error('No images extracted');
      saveToHistory(id, foundUrl);
      setSearchTime((performance.now() - startTime) / 1000);
      return;
    }

    setExtractedImages(sorted);
    saveToHistory(id, foundUrl, sorted[0]);
    toast.success(`Found ${sorted.length} images`);
    setSearchTime((performance.now() - startTime) / 1000);
  };

  // Image viewer functions
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
    if (selectedImageIndex !== null && selectedImageIndex > 0 && !isTransitioning) {
      setIsTransitioning(true);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setTimeout(() => {
        setSelectedImageIndex(selectedImageIndex - 1);
        setIsTransitioning(false);
      }, 100);
    }
  };

  const goToNext = () => {
    if (selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1 && !isTransitioning) {
      setIsTransitioning(true);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
      setTimeout(() => {
        setSelectedImageIndex(selectedImageIndex + 1);
        setIsTransitioning(false);
      }, 100);
    }
  };

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 5));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.5));

  // Touch handlers
  const getTouchDistance = (t1: React.Touch, t2: React.Touch) => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      touchStartRef.current = {
        distance: getTouchDistance(e.touches[0], e.touches[1]),
        zoom
      };
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        // Double tap
        if (zoom === 1) {
          setZoom(2);
        } else {
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        }
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
        swipeStartRef.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          time: now
        };
        if (zoom > 1) {
          setDragStart({ x: e.touches[0].clientX - position.x, y: e.touches[0].clientY - position.y });
        }
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = dist / touchStartRef.current.distance;
      setZoom(Math.min(Math.max(touchStartRef.current.zoom * scale, 0.5), 5));
    } else if (e.touches.length === 1 && zoom > 1) {
      e.preventDefault();
      setPosition({
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y
      });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartRef.current && zoom === 1 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - swipeStartRef.current.x;
      const deltaTime = Date.now() - swipeStartRef.current.time;
      if (Math.abs(deltaX) > 50 && deltaTime < 300) {
        if (deltaX > 0) goToPrevious();
        else goToNext();
      }
    }
    touchStartRef.current = null;
    swipeStartRef.current = null;
  };

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1) {
      e.preventDefault();
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  };

  const handleMouseUp = () => setIsDragging(false);
  const handleMouseLeave = () => setIsDragging(false);

  useEffect(() => {
    if (zoom === 1) setPosition({ x: 0, y: 0 });
  }, [zoom]);

  // Camera functions
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      setCameraStream(stream);
      setShowCameraDialog(true);
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      }, 100);
    } catch {
      toast.error('Camera access denied');
    }
  };

  const stopCamera = () => {
    cameraStream?.getTracks().forEach(track => track.stop());
    setCameraStream(null);
    if (videoRef.current) videoRef.current.srcObject = null;
    setShowCameraDialog(false);
    setCapturedImage(null);
    setDetectedIDs([]);
    setSelectableTexts([]);
  };

  const captureImage = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const imageData = canvas.toDataURL('image/jpeg', 0.92);
    setCapturedImage(imageData);
    cameraStream?.getTracks().forEach(track => track.stop());
    setCameraStream(null);
    await extractTextFromImage(imageData);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setDetectedIDs([]);
    setSelectableTexts([]);
    startCamera();
  };

  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);
    try {
      const formData = new FormData();
      formData.append('base64Image', imageData);
      formData.append('apikey', OCR_SPACE_API_KEY);
      formData.append('language', 'eng');
      formData.append('OCREngine', '2');

      const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData
      });

      const result = await response.json();
      const text = result.ParsedResults?.[0]?.ParsedText || '';

      const words = text.split(/\s+/).filter((w: string) => w.trim());
      setSelectableTexts(words.map((word: string) => ({
        text: word.trim(),
        isNumber: /\d{5,}/.test(word)
      })));

      const ids = new Set<string>();
      const matches = text.match(/\b\d{6,12}\b/g) || [];
      matches.forEach((m: string) => ids.add(m));
      setDetectedIDs([...ids]);

      if (ids.size === 0) {
        toast.info('No IDs detected. Tap text to search.');
      } else {
        toast.success(`Found ${ids.size} ID(s)`);
      }
    } catch {
      toast.error('OCR failed');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const useDetectedID = (id: string) => {
    setProductId(id);
    stopCamera();
    toast.success(`Searching: ${id}`);
    setTimeout(() => handleSearch(id), 50);
  };

  const handleTextSelect = (text: string) => {
    const numbers = text.match(/\d+/g);
    const searchText = numbers ? numbers.join('') : text;
    setProductId(searchText);
    stopCamera();
    toast.success(`Searching: ${searchText}`);
    setTimeout(() => handleSearch(searchText), 50);
  };

  useEffect(() => {
    return () => {
      cameraStream?.getTracks().forEach(track => track.stop());
    };
  }, [cameraStream]);

  const loadedCount = loadedImages.size;

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent mb-2">
            Product Image Finder
          </h1>
          <p className="text-gray-600">Search JioMart products by ID</p>
        </div>

        {/* Search Section */}
        <div className="bg-white rounded-2xl shadow-xl p-6 mb-8">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              type="text"
              placeholder="Enter Product ID..."
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="flex-1"
            />
            <Button onClick={() => handleSearch()} disabled={loading}>
              <Search className="w-4 h-4 mr-2" />
              {loading ? 'Finding...' : 'Find'}
            </Button>
            <Button onClick={startCamera} variant="outline">
              <Scan className="w-4 h-4 mr-2" />
              Scan
            </Button>
          </div>
        </div>

        {/* Loading Skeletons */}
        {loading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-8">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        {/* Images Grid */}
        {extractedImages.length > 0 && (
          <div className="bg-white rounded-2xl shadow-xl p-6">
            <div className="flex flex-wrap items-center justify-between mb-4 gap-2">
              <h2 className="text-2xl font-bold text-gray-800">
                Product Images ({extractedImages.length})
              </h2>
              {searchTime !== null && (
                <span className="text-sm text-gray-500">{searchTime.toFixed(2)}s</span>
              )}
              {loadedCount < extractedImages.length && (
                <span className="text-sm text-purple-600">{loadedCount}/{extractedImages.length}</span>
              )}
              {jiomartUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  className="gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Product
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {extractedImages.map((url, index) => (
                <div
                  key={url}
                  onClick={() => openImage(index)}
                  className="relative aspect-square rounded-lg overflow-hidden cursor-pointer group bg-gray-100 hover:ring-4 hover:ring-purple-400 transition-all"
                >
                  <img
                    src={url}
                    alt={`Product ${index + 1}`}
                    className={`w-full h-full object-cover transition-opacity duration-300 ${
                      loadedImages.has(url) ? 'opacity-100' : 'opacity-0'
                    }`}
                    onLoad={() => handleImageLoad(url)}
                  />
                  {!loadedImages.has(url) && (
                    <Skeleton className="absolute inset-0" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Image Viewer Dialog */}
        <Dialog open={selectedImageIndex !== null} onOpenChange={(open) => !open && closeImage()}>
          <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 overflow-hidden bg-black/95">
            <DialogTitle className="sr-only">Product Image Viewer</DialogTitle>
            <DialogDescription className="sr-only">View and navigate product images</DialogDescription>
            {selectedImageIndex !== null && (
              <div className="relative w-full h-full flex items-center justify-center">
                <div className="absolute top-4 right-4 z-10 flex gap-2">
                  <Button size="icon" variant="secondary" onClick={handleZoomOut} disabled={zoom <= 0.5}>
                    <ZoomOut className="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="secondary" onClick={handleZoomIn} disabled={zoom >= 5}>
                    <ZoomIn className="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="secondary" onClick={closeImage}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                {selectedImageIndex > 0 && (
                  <Button size="icon" variant="secondary" className="absolute left-4 z-10" onClick={goToPrevious}>
                    <ChevronLeft className="w-6 h-6" />
                  </Button>
                )}

                <div
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseLeave}
                  className="w-full h-full flex items-center justify-center overflow-hidden"
                >
                  <img
                    ref={imageRef}
                    src={extractedImages[selectedImageIndex]}
                    alt={`Product ${selectedImageIndex + 1}`}
                    style={{
                      transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                      transition: isTransitioning ? 'transform 0.3s ease-out' : 'none',
                      cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                      userSelect: 'none',
                      touchAction: 'none'
                    }}
                    className="max-w-[80vw] max-h-[80vh] object-contain"
                    draggable={false}
                  />
                </div>

                {selectedImageIndex < extractedImages.length - 1 && (
                  <Button size="icon" variant="secondary" className="absolute right-4 z-10" onClick={goToNext}>
                    <ChevronRight className="w-6 h-6" />
                  </Button>
                )}

                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 text-white px-4 py-2 rounded-full text-sm">
                  {selectedImageIndex + 1} / {extractedImages.length}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Camera Dialog */}
        <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
          <DialogContent className="max-w-[95vw] max-h-[95vh] p-6">
            <DialogTitle>Camera Scanner</DialogTitle>
            <DialogDescription>Capture product image for text extraction</DialogDescription>
            {!capturedImage ? (
              <>
                <div className="relative bg-black rounded-lg overflow-hidden">
                  <video ref={videoRef} autoPlay playsInline className="w-full h-auto" />
                  <canvas ref={canvasRef} className="hidden" />
                </div>
                <p className="text-sm text-gray-600 text-center">Position product ID within the frame</p>
                <Button onClick={captureImage} className="w-full">Capture</Button>
              </>
            ) : (
              <>
                <img src={capturedImage} alt="Captured" className="w-full rounded-lg" />
                {isProcessingOCR && <p className="text-center text-purple-600">Extracting text...</p>}
                {!isProcessingOCR && selectableTexts.length > 0 && (
                  <div className="space-y-3">
                    {detectedIDs.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="font-semibold text-sm">Product IDs</h3>
                        {detectedIDs.map((id, index) => (
                          <button
                            key={index}
                            onClick={() => useDetectedID(id)}
                            className="w-full bg-primary/95 hover:bg-primary text-primary-foreground rounded-lg px-4 py-3 text-base font-mono font-bold shadow-lg transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-between"
                          >
                            {id}
                            <Search className="w-4 h-4" />
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="text-sm text-gray-600">Tap any text to search</p>
                    <div className="flex flex-wrap gap-2">
                      {selectableTexts.map((item, index) => (
                        <button
                          key={index}
                          onClick={() => handleTextSelect(item.text)}
                          className={`px-3 py-2 rounded-md text-sm font-medium transition-all hover:scale-105 active:scale-95 ${
                            item.isNumber
                              ? 'bg-primary/80 hover:bg-primary text-primary-foreground font-mono'
                              : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                          }`}
                        >
                          {item.text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {!isProcessingOCR && selectableTexts.length === 0 && (
                  <Button onClick={retakePhoto} variant="outline" className="w-full">Retake Photo</Button>
                )}
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* History Dialog */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogTitle>Search History</DialogTitle>
            <DialogDescription>Your recent product searches</DialogDescription>
            {searchHistory.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No search history yet</p>
            ) : (
              <div className="space-y-3">
                {searchHistory.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt="" className="w-16 h-16 object-cover rounded" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-mono font-semibold">ID: {item.productId}</p>
                      <p className="text-sm text-gray-500">{new Date(item.timestamp).toLocaleString()}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setProductId(item.productId);
                          setShowHistoryDialog(false);
                          handleSearch(item.productId);
                        }}
                      >
                        <Search className="w-4 h-4" />
                      </Button>
                      {item.jiomartUrl && (
                        <Button size="sm" variant="outline" onClick={() => window.open(item.jiomartUrl, '_blank')}>
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* History Button */}
        <Button
          onClick={() => setShowHistoryDialog(true)}
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-2xl z-50 hover:scale-110 transition-transform"
          size="icon"
          title="Search History"
        >
          <History className="w-6 h-6" />
        </Button>
      </div>
    </div>
  );
};
