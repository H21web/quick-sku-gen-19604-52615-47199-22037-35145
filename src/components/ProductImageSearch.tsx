import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Scan, ExternalLink, History, Camera, ChevronLeft, ChevronRight } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages, preloadImages } from '@/lib/imageExtractor';
import { GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_SPACE_API_KEY = 'K86120042088957';
const GOOGLE_API_KEYS = [
  'AIzaSyCUb-RrSjsScT_gfhmdyOMVp3ZHSSsai1U',
  'AIzaSyDVvxwYZzZAOLy5Cd3FMNrQKcxZxldsJCY',
  'AIzaSyBdRbGEG_nLOhaI1_RpNTN6kiwhEVcuxXo',
  'AIzaSyDsTLL2TqDbV2DhXEwxny_5VIb1IjmQVn0',
  'AIzaSyC0RGsJ8Q0Ery9CjyLBEp25REWV_SqpQPE',
  'AIzaSyB5tGVlcRpnrRkfrttWo4kMK1-9PGj15y4'
];

interface SearchHistoryItem {
  id: string;
  productId: string;
  timestamp: number;
  jiomartUrl?: string;
  thumbnail?: string;
}

interface ApiKeyStatus {
  key: string;
  exhausted: boolean;
  lastReset: number;
}

// ✅ NEW: Smart Image Component
// Handles loading state internally to prevent "pop-in" of partially loaded images
const FadeInImage = ({ src, index, onClick }: { src: string, index: number, onClick: () => void }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  if (hasError) return null; // Hide broken images completely

  return (
    <div
      onClick={onClick}
      className="relative aspect-square border rounded-lg overflow-hidden bg-gray-50 cursor-pointer group hover:shadow-md transition-all"
    >
      {/* Skeleton loader shows until image is ready */}
      {!isLoaded && <Skeleton className="w-full h-full absolute inset-0 animate-pulse bg-gray-200" />}
      
      <img
        src={src}
        alt={`Product ${index + 1}`}
        className={`w-full h-full object-contain p-2 bg-white transition-opacity duration-300 ease-in-out ${
          isLoaded ? 'opacity-100' : 'opacity-0'
        }`}
        onLoad={() => setIsLoaded(true)}
        onError={() => setHasError(true)}
        loading="lazy"
      />
      
      {/* Badge only shows after load to look clean */}
      {isLoaded && (
        <div className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm">
          {index + 1}
        </div>
      )}
    </div>
  );
};

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  
  // Camera & OCR States
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [showScanAnimation, setShowScanAnimation] = useState(false);

  // Data States
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [isAutoLoading, setIsAutoLoading] = useState(false);

  // Pan/Zoom States
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentSearchIdRef = useRef('');
  const processedLinksRef = useRef<Set<string>>(new Set());
  const currentKeyIndexRef = useRef(0);

  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Load History
  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      try {
        setSearchHistory(JSON.parse(savedHistory));
      } catch {
        localStorage.removeItem('searchHistory');
      }
    }

    const resetInterval = setInterval(() => {
      setApiKeyStatuses(prev =>
        prev.map(status => ({ ...status, exhausted: false, lastReset: Date.now() }))
      );
    }, 3600000);
    return () => clearInterval(resetInterval);
  }, []);

  // API Key Management
  const getNextApiKey = useCallback((): string | null => {
    const availableKeys = apiKeyStatuses.filter(k => !k.exhausted);
    if (availableKeys.length === 0) return null;
    const key = availableKeys[currentKeyIndexRef.current % availableKeys.length];
    currentKeyIndexRef.current++;
    return key.key;
  }, [apiKeyStatuses]);

  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev =>
      prev.map(status => status.key === apiKey ? { ...status, exhausted: true } : status)
    );
  }, []);

  const fetchWithRetry = async (buildUrl: (apiKey: string) => string, maxRetries: number = GOOGLE_API_KEYS.length): Promise<Response> => {
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < maxRetries) {
      const apiKey = getNextApiKey();
      if (!apiKey) throw new Error('All API keys exhausted. Please try again later.');

      try {
        const url = buildUrl(apiKey);
        const response = await fetch(url);
        
        if (response.ok) return response;

        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || '';
        const isRateLimitError = response.status === 429 || errorMessage.toLowerCase().includes('quota');

        if (isRateLimitError) {
          console.warn(`API key exhausted, rotating to next key...`);
          markApiKeyExhausted(apiKey);
          attempts++;
          continue;
        }
        throw new Error(errorMessage || `API request failed with status ${response.status}`);
      } catch (error: any) {
        lastError = error;
        if (error.message.includes('fetch') || error.message.includes('network')) {
          attempts++;
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error('All API keys failed');
  };

  const saveToHistory = useCallback((productId: string, jiomartUrl?: string, thumbnail?: string) => {
    setSearchHistory((prevHistory) => {
      const existingIndex = prevHistory.findIndex(item => item.productId === productId);
      if (existingIndex !== -1) {
        const updatedItem = {
          ...prevHistory[existingIndex],
          timestamp: Date.now(),
          jiomartUrl: jiomartUrl || prevHistory[existingIndex].jiomartUrl,
          thumbnail: thumbnail || prevHistory[existingIndex].thumbnail
        };
        const updatedHistory = [updatedItem, ...prevHistory.filter((_, idx) => idx !== existingIndex)].slice(0, 20);
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        return updatedHistory;
      } else {
        const newHistoryItem: SearchHistoryItem = {
          id: Date.now().toString(),
          productId,
          timestamp: Date.now(),
          jiomartUrl,
          thumbnail
        };
        const updatedHistory = [newHistoryItem, ...prevHistory].slice(0, 20);
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        return updatedHistory;
      }
    });
  }, []);

  // ✅ OPTIMIZED: Faster Simultaneous Loading
  const loadAllImagesSimultaneously = useCallback(async (links: string[], searchId: string) => {
    setIsAutoLoading(true);
    
    // Increased batch size for faster execution
    const batchSize = 8;
    const batches: string[][] = [];

    for (let i = 0; i < links.length; i += batchSize) {
      batches.push(links.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      if (searchId !== currentSearchIdRef.current) break;

      const batchResults = await Promise.allSettled(
        batch.map(async (link) => {
          if (processedLinksRef.current.has(link)) return [];
          try {
            // Reduced timeout for faster failure handling
            const images = await Promise.race([
              extractAllProductImages(link),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
            ]);
            processedLinksRef.current.add(link);
            return Array.isArray(images) ? images : [];
          } catch (error) {
            processedLinksRef.current.add(link);
            return [];
          }
        })
      );

      const newImages = batchResults
        .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
        .flatMap(r => r.value);

      if (newImages.length > 0 && searchId === currentSearchIdRef.current) {
        setExtractedImages(prev => {
          const combined = [...prev, ...newImages];
          const unique = Array.from(new Set(combined));
          // Sort high-res images to front
          return [
            ...unique.filter(url => url.includes('/original/')),
            ...unique.filter(url => !url.includes('/original/'))
          ];
        });
      }
      
      // Removed the 50ms delay for maximum speed
    }
    setIsAutoLoading(false);
  }, []);

  const handleSearch = useCallback(async (searchId?: string) => {
    const idToSearch = searchId || productId;
    if (!idToSearch.trim()) {
      toast.error('Please enter a product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Google Search Engine ID not configured');
      return;
    }

    const newSearchId = `${idToSearch}_${Date.now()}`;
    currentSearchIdRef.current = newSearchId;
    
    setLoading(true);
    setExtractedImages([]);
    setJiomartUrl('');
    processedLinksRef.current.clear();

    try {
      const query = `site:jiomart.com ${idToSearch}`;
      
      const [imageResponse, webResponse] = await Promise.all([
        fetchWithRetry((apiKey) => 
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=10&fields=items(link)`
        ),
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1&fields=items(link)`
        )
      ]);

      const [imageData, webData] = await Promise.all([
        imageResponse.json(),
        webResponse.json()
      ]);

      let foundUrl = '';
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        foundUrl = webData.items[0].link;
        setJiomartUrl(foundUrl);
      }
      saveToHistory(idToSearch, foundUrl);

      if (!imageData.items?.length) {
        toast.error('No images found');
        return;
      }

      const jiomartLinks = Array.from(new Set(
        imageData.items
          .map((item: any) => item.link)
          .filter((url: string) => url.includes('jiomart.com/images/product'))
      )) as string[];

      if (!jiomartLinks.length) {
        toast.error('No product images found');
        return;
      }

      // Fast Path: Load first link immediately
      const firstLink = jiomartLinks[0];
      try {
        const firstImages = await extractAllProductImages(firstLink);
        processedLinksRef.current.add(firstLink);
        
        if (firstImages.length > 0) {
          setExtractedImages(firstImages);
          preloadImages(firstImages, 12);
          setTimeout(() => {
            saveToHistory(idToSearch, foundUrl, firstImages[0]);
          }, 200);
        }
      } catch (error) {
        processedLinksRef.current.add(firstLink);
      }

      // Background load remaining links faster
      const remainingLinks = jiomartLinks.slice(1);
      if (remainingLinks.length > 0) {
        // Almost instant follow-up
        setTimeout(() => {
          loadAllImagesSimultaneously(remainingLinks, newSearchId);
        }, 50);
        toast.success('Images loading...');
      }

    } catch (error: any) {
      console.error('Search error:', error);
      if (error.message.includes('exhausted')) {
        toast.error('All API keys exhausted. Please try again in an hour.');
      } else {
        toast.error(error.message || 'Search failed. Try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, getNextApiKey, markApiKeyExhausted, fetchWithRetry, loadAllImagesSimultaneously]);

  // Camera Functions
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
    } catch (error) {
      toast.error('Camera access denied or not available');
    }
  };

  const stopCamera = () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setShowCameraDialog(false);
    setCapturedImage(null);
    setDetectedIDs([]);
    setShowScanAnimation(false);
  };

  const captureImage = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = canvas.toDataURL('image/jpeg', 0.9);
    setCapturedImage(imageData);
    
    setShowScanAnimation(true);
    setTimeout(() => setShowScanAnimation(false), 600);
    
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }
    await extractTextFromImage(imageData);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setDetectedIDs([]);
    startCamera();
  };

  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);
    try {
      const img = new Image();
      img.src = imageData;
      await new Promise((resolve) => { img.onload = resolve; });

      const canvas = document.createElement('canvas');
      const maxDimension = 800;
      let width = img.width;
      let height = img.height;

      if (width > height && width > maxDimension) {
        height = (height / width) * maxDimension;
        width = maxDimension;
      } else if (height > maxDimension) {
        width = (width / height) * maxDimension;
        height = maxDimension;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        const compressedImage = canvas.toDataURL('image/jpeg', 0.7);

        const formData = new FormData();
        formData.append('base64Image', compressedImage);
        formData.append('apikey', OCR_SPACE_API_KEY);
        formData.append('language', 'eng');
        formData.append('isOverlayRequired', 'false');
        formData.append('detectOrientation', 'true');
        formData.append('scale', 'true');
        formData.append('OCREngine', '2');

        const response = await fetch('https://api.ocr.space/parse/image', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) throw new Error('OCR failed');
        
        const result = await response.json();
        if (result.IsErroredOnProcessing) throw new Error(result.ErrorMessage?.[0] || 'OCR failed');

        const extractedText = result.ParsedResults?.[0]?.ParsedText || '';
        const foundIDs = new Set<string>();
        const fullText = extractedText.replace(/\n/g, ' ');
        const cleanedText = fullText
          .replace(/[oO]/g, '0')
          .replace(/[lI|]/g, '1')
          .replace(/[sS]/g, '5')
          .replace(/[bB]/g, '8');

        const idPatterns = [
          /ID\s*[:：.,-]?\s*(\d{5,})/gi,
          /[1I]D\s*[:：.,-]?\s*(\d{5,})/gi,
          /Product\s*[:：.,-]?\s*(\d{5,})/gi,
          /Item\s*[:：.,-]?\s*(\d{5,})/gi,
          /Code\s*[:：.,-]?\s*(\d{5,})/gi,
        ];

        for (const pattern of idPatterns) {
          const matches = [...fullText.matchAll(pattern), ...cleanedText.matchAll(pattern)];
          matches.forEach(m => m[1] && foundIDs.add(m[1].replace(/\D/g, '')));
        }

        if (foundIDs.size === 0) {
          const numberMatches = [...fullText.matchAll(/\b(\d{6,12})\b/g)];
          numberMatches.forEach(m => m[1] && foundIDs.add(m[1]));
        }

        if (foundIDs.size === 0) {
          const separatedNumbers = fullText.match(/\d[\d\s\-_.]+\d/g) || [];
          separatedNumbers.forEach(num => {
            const cleaned = num.replace(/\D/g, '');
            if (cleaned.length >= 6) foundIDs.add(cleaned);
          });
        }

        const uniqueIDs = Array.from(foundIDs).filter(id => id.length >= 6 && id.length <= 12);
        setDetectedIDs(uniqueIDs);
        
        if (uniqueIDs.length === 0) {
          toast.info('No product IDs detected');
        } else {
          const firstID = uniqueIDs[0];
          setProductId(firstID);
          stopCamera();
          toast.success(`Found ${uniqueIDs.length} ID(s). Searching: ${firstID}`);
          setTimeout(() => handleSearch(firstID), 100);
        }
      }
    } catch (error: any) {
      console.error('OCR error:', error);
      toast.error('OCR failed. Try again.');
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

  // Fullscreen Navigation Logic
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

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const distance = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchStartRef.current = { distance, zoom, x: position.x, y: position.y };
    } else if (e.touches.length === 1) {
      swipeStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
      if (zoom > 1) {
        setIsDragging(true);
        setDragStart({ x: e.touches[0].clientX - position.x, y: e.touches[0].clientY - position.y });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const distance = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const scale = distance / touchStartRef.current.distance;
      setZoom(Math.min(Math.max(touchStartRef.current.zoom * scale, 1), 5));
    } else if (e.touches.length === 1 && zoom > 1 && isDragging) {
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
    setIsDragging(false);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Compact Header */}
      <div className="bg-white border-b px-4 py-3 sticky top-0 z-30 shadow-sm safe-area-top">
        <div className="flex items-center gap-2 max-w-4xl mx-auto">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
            <Input
              placeholder="Enter Product ID (e.g. 59000123)"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="pl-10 pr-10 h-11 text-lg"
              // ✅ FIXED: Force number pad on mobile
              inputMode="numeric"
              pattern="[0-9]*"
            />
            {productId && (
              <button
                onClick={() => setProductId('')}
                className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
          
          <Button onClick={() => setShowCameraDialog(true)} variant="outline" size="icon" className="h-11 w-11 shrink-0">
            <Scan className="h-5 w-5" />
          </Button>

          <Button onClick={() => handleSearch()} disabled={loading} className="h-11 px-6 font-semibold">
            {loading ? '...' : 'Find'}
          </Button>
        </div>

        {/* Status Bar */}
        {(extractedImages.length > 0 || jiomartUrl || searchHistory.length > 0) && (
          <div className="flex items-center justify-between mt-3 max-w-4xl mx-auto text-sm text-gray-600">
            <div className="flex items-center gap-2">
              {extractedImages.length > 0 && (
                <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-medium">
                  {extractedImages.length} Img {isAutoLoading && '(Loading...)'}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {jiomartUrl && (
                <Button variant="ghost" size="sm" onClick={() => window.open(jiomartUrl, '_blank')} className="h-7 px-2">
                  <ExternalLink className="h-3 w-3 mr-1" /> Open
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setShowHistoryDialog(true)} className="h-7 px-2">
                <History className="h-3 w-3 mr-1" /> History
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading && extractedImages.length === 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-4xl mx-auto">
            {[...Array(10)].map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3 max-w-4xl mx-auto pb-24">
          {extractedImages.map((url, index) => (
            // ✅ FIXED: Using smart image component
            <FadeInImage
              key={`${url}-${index}`}
              src={url}
              index={index}
              onClick={() => {
                setSelectedImageIndex(index);
                setZoom(1);
                setPosition({ x: 0, y: 0 });
              }}
            />
          ))}
        </div>
      </div>

      {/* Fullscreen Slideshow (Unchanged logic, just rendered conditionally) */}
      {selectedImageIndex !== null && (
        <div 
          className="fixed inset-0 z-50 bg-black flex items-center justify-center overflow-hidden touch-none"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* Controls */}
          <button 
            onClick={() => setSelectedImageIndex(null)}
            className="absolute top-4 right-4 p-3 rounded-full bg-black/40 hover:bg-black/60 text-white z-50"
          >
            <X className="w-6 h-6" />
          </button>

          {!isMobile && (
            <>
              {selectedImageIndex > 0 && (
                <button onClick={goToPrevious} className="absolute left-4 p-4 bg-black/20 hover:bg-black/40 rounded-full text-white z-50">
                  <ChevronLeft className="w-8 h-8" />
                </button>
              )}
              {selectedImageIndex < extractedImages.length - 1 && (
                <button onClick={goToNext} className="absolute right-4 p-4 bg-black/20 hover:bg-black/40 rounded-full text-white z-50">
                  <ChevronRight className="w-8 h-8" />
                </button>
              )}
            </>
          )}

          <div 
            className="relative w-full h-full flex items-center justify-center transition-transform duration-200 ease-out"
            style={{ 
              transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
              cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default'
            }}
            onMouseDown={(e) => zoom > 1 && setIsDragging(true)}
            onMouseMove={(e) => isDragging && zoom > 1 && setPosition({
              x: e.clientX - e.movementX, // Simplified for mouse
              y: e.clientY - e.movementY
            })}
            onMouseUp={() => setIsDragging(false)}
          >
            <img
              src={extractedImages[selectedImageIndex]}
              alt="Fullscreen"
              className="max-w-full max-h-full object-contain select-none"
              draggable={false}
            />
          </div>

          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/40 px-4 py-2 rounded-full text-white text-sm">
            {selectedImageIndex + 1} / {extractedImages.length} {zoom > 1 && `(${Math.round(zoom * 100)}%)`}
          </div>
        </div>
      )}

      {/* Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="sm:max-w-md p-0 h-[100dvh] sm:h-auto border-0 sm:border rounded-none sm:rounded-lg bg-black text-white flex flex-col">
          <div className="p-4 flex justify-between items-center bg-black/50 z-10 absolute top-0 w-full">
            <DialogTitle className="text-lg font-medium">Scan Product</DialogTitle>
            <button onClick={stopCamera}><X className="w-6 h-6" /></button>
          </div>

          <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
            {!capturedImage ? (
              <>
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                <div className="absolute inset-0 border-[40px] border-black/50 pointer-events-none">
                  <div className="w-full h-full border-2 border-white/50 relative">
                    <div className="absolute top-0 left-0 w-6 h-6 border-l-4 border-t-4 border-primary"></div>
                    <div className="absolute top-0 right-0 w-6 h-6 border-r-4 border-t-4 border-primary"></div>
                    <div className="absolute bottom-0 left-0 w-6 h-6 border-l-4 border-b-4 border-primary"></div>
                    <div className="absolute bottom-0 right-0 w-6 h-6 border-r-4 border-b-4 border-primary"></div>
                  </div>
                </div>
                <div className="absolute bottom-24 left-0 right-0 flex justify-center">
                  <Button onClick={captureImage} size="icon" className="h-20 w-20 rounded-full border-4 border-white bg-transparent hover:bg-white/20" />
                </div>
              </>
            ) : (
              <div className="relative w-full h-full">
                <img src={capturedImage} alt="Captured" className="w-full h-full object-contain" />
                {showScanAnimation && (
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/20 to-transparent animate-scan" />
                )}
                <canvas ref={canvasRef} className="hidden" />
              </div>
            )}
          </div>

          {capturedImage && (
            <div className="p-4 bg-zinc-900 space-y-3">
              {isProcessingOCR ? (
                <div className="text-center py-4">Extracting text...</div>
              ) : detectedIDs.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm text-gray-400">Detected IDs:</div>
                  <div className="grid grid-cols-2 gap-2">
                    {detectedIDs.map(id => (
                      <Button key={id} onClick={() => useDetectedID(id)} variant="secondary" className="justify-between">
                        {id} <ChevronRight className="w-4 h-4 opacity-50" />
                      </Button>
                    ))}
                  </div>
                </div>
              ) : (
                <Button onClick={retakePhoto} variant="destructive" className="w-full">Retake Photo</Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Search History</DialogTitle>
          <div className="space-y-2 mt-4 max-h-[60vh] overflow-y-auto">
            {searchHistory.length === 0 ? (
              <p className="text-center text-gray-500 py-8">No recent history</p>
            ) : (
              searchHistory.map((item) => (
                <div key={item.id} onClick={() => { setProductId(item.productId); setShowHistoryDialog(false); handleSearch(item.productId); }} className="flex items-center gap-3 p-3 hover:bg-gray-100 rounded-lg cursor-pointer border">
                  <div className="w-12 h-12 bg-gray-200 rounded flex-shrink-0 overflow-hidden">
                    {item.thumbnail ? <img src={item.thumbnail} className="w-full h-full object-cover" /> : <Search className="w-6 h-6 m-auto text-gray-400" />}
                  </div>
                  <div>
                    <div className="font-medium">{item.productId}</div>
                    <div className="text-xs text-gray-500">{new Date(item.timestamp).toLocaleDateString()}</div>
                  </div>
                </div>
              ))
            )}
            {searchHistory.length > 0 && (
              <Button onClick={() => { setSearchHistory([]); localStorage.removeItem('searchHistory'); }} variant="ghost" className="w-full text-red-500 hover:text-red-600 hover:bg-red-50">
                Clear History
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
