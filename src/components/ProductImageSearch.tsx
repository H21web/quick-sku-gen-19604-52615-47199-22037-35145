import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Camera, ExternalLink, History, ChevronLeft, ChevronRight, Loader2, ScanLine } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';

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

// ==================== CORRECT IMAGE EXTRACTOR ====================
// Pattern: https://www.jiomart.com/images/product/original/{ID}/{slug}-{type}-o{ID}-p{ID}-{index}-{timestamp}.jpg
const extractAllProductImages = async (productId: string, sampleUrl?: string): Promise<string[]> => {
  const validImages: string[] = [];
  
  // Helper to check if image exists
  const checkImage = (url: string): Promise<string | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      const timeout = setTimeout(() => {
        img.src = '';
        resolve(null);
      }, 500);
      
      img.onload = () => {
        clearTimeout(timeout);
        resolve(url);
      };
      
      img.onerror = () => {
        clearTimeout(timeout);
        resolve(null);
      };
      
      img.src = url;
    });
  };

  // Extract pattern from sample URL
  let slug = '';
  let timestamp = '';
  
  if (sampleUrl) {
    // Example: parle-g-original-glucose-biscuits-800-g-product-images-o490008739-p490008739-0-202203170454.jpg
    const match = sampleUrl.match(/\/([^\/]+)-(product-images|legal-images)-o\d+-p\d+-\d+-(\d+)\.jpg/);
    if (match) {
      slug = match[1];
      timestamp = match[3];
    }
  }

  const checkPromises: Promise<string | null>[] = [];

  if (slug && timestamp) {
    // Pattern found - use exact format
    for (let i = 0; i < 50; i++) {
      checkPromises.push(
        checkImage(`https://www.jiomart.com/images/product/original/${productId}/${slug}-product-images-o${productId}-p${productId}-${i}-${timestamp}.jpg`)
      );
      checkPromises.push(
        checkImage(`https://www.jiomart.com/images/product/original/${productId}/${slug}-legal-images-o${productId}-p${productId}-${i}-${timestamp}.jpg`)
      );
    }
  } else {
    // Fallback: Try common patterns
    const commonSlugs = ['product', 'item', productId];
    const currentYear = new Date().getFullYear();
    const timestamps = [];
    
    // Generate possible timestamps (last 3 years)
    for (let year = currentYear; year >= currentYear - 3; year--) {
      for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= 28; day += 7) {
          const m = String(month).padStart(2, '0');
          const d = String(day).padStart(2, '0');
          timestamps.push(`${year}${m}${d}0000`);
        }
      }
    }

    for (const ts of timestamps.slice(0, 10)) {
      for (const s of commonSlugs) {
        for (let i = 0; i < 5; i++) {
          checkPromises.push(
            checkImage(`https://www.jiomart.com/images/product/original/${productId}/${s}-product-images-o${productId}-p${productId}-${i}-${ts}.jpg`)
          );
        }
      }
    }
  }

  const results = await Promise.all(checkPromises);
  const uniqueImages = new Set(results.filter((url): url is string => url !== null));
  
  return Array.from(uniqueImages);
};

const preloadImages = (urls: string[], limit: number = 20) => {
  urls.slice(0, limit).forEach(url => {
    const img = new Image();
    img.src = url;
  });
};

// ==================== MAIN COMPONENT ====================
export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );
  const currentKeyIndexRef = useRef(0);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  useEffect(() => {
    try {
      const savedHistory = localStorage.getItem('searchHistory');
      if (savedHistory) {
        const parsed = JSON.parse(savedHistory);
        setSearchHistory(Array.isArray(parsed) ? parsed : []);
      }
    } catch (error) {
      console.error('Failed to load history:', error);
      localStorage.removeItem('searchHistory');
    }

    const resetInterval = setInterval(() => {
      setApiKeyStatuses(prev =>
        prev.map(status => ({ ...status, exhausted: false, lastReset: Date.now() }))
      );
    }, 3600000);

    return () => clearInterval(resetInterval);
  }, []);

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

  const fetchWithRetry = async (
    buildUrl: (apiKey: string) => string,
    maxRetries: number = GOOGLE_API_KEYS.length
  ): Promise<Response> => {
    let attempts = 0;

    while (attempts < maxRetries) {
      const apiKey = getNextApiKey();
      if (!apiKey) throw new Error('All API keys exhausted');

      try {
        const response = await fetch(buildUrl(apiKey));
        if (response.ok) return response;

        const errorData = await response.json().catch(() => ({}));
        const isRateLimitError =
          response.status === 429 ||
          errorData.error?.message?.toLowerCase().includes('quota') ||
          errorData.error?.message?.toLowerCase().includes('limit');

        if (isRateLimitError) {
          markApiKeyExhausted(apiKey);
          attempts++;
          continue;
        }

        throw new Error(errorData.error?.message || `Request failed`);
      } catch (error: any) {
        if (error.message.includes('fetch') || error.message.includes('network')) {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        throw error;
      }
    }

    throw new Error('All API requests failed');
  };

  const saveToHistory = useCallback((productId: string, jiomartUrl?: string, thumbnail?: string) => {
    if (!productId?.trim()) return;

    setSearchHistory((prev) => {
      try {
        const existingIndex = prev.findIndex(item => item.productId === productId);
        
        if (existingIndex !== -1) {
          const updated = {
            ...prev[existingIndex],
            timestamp: Date.now(),
            jiomartUrl: jiomartUrl || prev[existingIndex].jiomartUrl,
            thumbnail: thumbnail || prev[existingIndex].thumbnail
          };
          const newHistory = [updated, ...prev.filter((_, idx) => idx !== existingIndex)].slice(0, 20);
          localStorage.setItem('searchHistory', JSON.stringify(newHistory));
          return newHistory;
        } else {
          const newItem: SearchHistoryItem = {
            id: Date.now().toString(),
            productId,
            timestamp: Date.now(),
            jiomartUrl,
            thumbnail
          };
          const newHistory = [newItem, ...prev].slice(0, 20);
          localStorage.setItem('searchHistory', JSON.stringify(newHistory));
          return newHistory;
        }
      } catch (error) {
        console.error('Failed to save history:', error);
        return prev;
      }
    });
  }, []);

  const handleSearch = useCallback(async (searchId?: string) => {
    const idToSearch = (searchId || productId).trim();
    
    if (!idToSearch) {
      toast.error('Please enter a product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Search engine not configured');
      return;
    }

    setLoading(true);
    setExtractedImages([]);
    setJiomartUrl('');

    try {
      const query = `site:jiomart.com ${idToSearch}`;
      
      const [webResponse, imageResponse] = await Promise.all([
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1&fields=items(link)`
        ),
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=5&fields=items(link)`
        )
      ]);

      const [webData, imageData] = await Promise.all([
        webResponse.json(),
        imageResponse.json()
      ]);

      let foundUrl = '';
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        foundUrl = webData.items[0].link;
        setJiomartUrl(foundUrl);
      }

      // Get sample image URL to extract pattern
      const sampleImageUrl = imageData.items?.find((item: any) => 
        item.link?.includes('jiomart.com/images/product/original')
      )?.link;

      const images = await extractAllProductImages(idToSearch, sampleImageUrl);
      
      if (images.length > 0) {
        setExtractedImages(images);
        preloadImages(images, 20);
        saveToHistory(idToSearch, foundUrl, images[0]);
        toast.success(`Found ${images.length} image${images.length !== 1 ? 's' : ''}`);
      } else {
        toast.error('No images found for this product');
      }
    } catch (error: any) {
      console.error('Search error:', error);
      
      if (error.message.includes('exhausted')) {
        toast.error('API limit reached. Try again later.');
      } else if (error.message.includes('network')) {
        toast.error('Network error. Check connection.');
      } else {
        toast.error('Search failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, fetchWithRetry]);

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
      console.error('Camera error:', error);
      toast.error('Camera access denied');
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

    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    await extractTextFromImage(imageData);
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
      if (ctx) ctx.drawImage(img, 0, 0, width, height);

      const compressedImage = canvas.toDataURL('image/jpeg', 0.7);
      
      const formData = new FormData();
      formData.append('base64Image', compressedImage);
      formData.append('apikey', OCR_SPACE_API_KEY);
      formData.append('language', 'eng');
      formData.append('OCREngine', '2');

      const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('OCR request failed');

      const result = await response.json();
      if (result.IsErroredOnProcessing) {
        throw new Error(result.ErrorMessage?.[0] || 'OCR failed');
      }

      const extractedText = result.ParsedResults?.[0]?.ParsedText || '';
      const foundIDs = new Set<string>();
      const fullText = extractedText.replace(/\n/g, ' ');

      const cleanedText = fullText
        .replace(/[oO]/g, '0')
        .replace(/[lI|]/g, '1')
        .replace(/[sS]/g, '5')
        .replace(/[bB]/g, '8');

      const idPatterns = [
        /ID\s*[:：.,-]?\s*(\d{6,})/gi,
        /Product\s*[:：.,-]?\s*(\d{6,})/gi,
        /Item\s*[:：.,-]?\s*(\d{6,})/gi,
        /Code\s*[:：.,-]?\s*(\d{6,})/gi,
      ];

      for (const pattern of idPatterns) {
        const matches = [...fullText.matchAll(pattern), ...cleanedText.matchAll(pattern)];
        matches.forEach(m => {
          if (m[1]) {
            const cleaned = m[1].replace(/\D/g, '');
            if (cleaned.length >= 6 && cleaned.length <= 12) {
              foundIDs.add(cleaned);
            }
          }
        });
      }

      if (foundIDs.size === 0) {
        const numberMatches = [...fullText.matchAll(/\b(\d{6,12})\b/g)];
        numberMatches.forEach(m => {
          if (m[1]) foundIDs.add(m[1]);
        });
      }

      const uniqueIDs = Array.from(foundIDs);
      setDetectedIDs(uniqueIDs);

      if (uniqueIDs.length === 0) {
        toast.info('No product IDs detected');
      } else {
        const firstID = uniqueIDs[0];
        setProductId(firstID);
        stopCamera();
        toast.success(`Found ${uniqueIDs.length} ID${uniqueIDs.length !== 1 ? 's' : ''}`);
        setTimeout(() => handleSearch(firstID), 100);
      }
    } catch (error: any) {
      console.error('OCR error:', error);
      toast.error('Failed to extract text');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const useDetectedID = (id: string) => {
    setProductId(id);
    stopCamera();
    setTimeout(() => handleSearch(id), 50);
  };

  const getTouchDistance = (touch1: Touch, touch2: Touch) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      touchStartRef.current = {
        distance: getTouchDistance(e.touches[0], e.touches[1]),
        zoom,
        x: position.x,
        y: position.y
      };
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
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = distance / touchStartRef.current.distance;
      setZoom(Math.min(Math.max(touchStartRef.current.zoom * scale, 1), 5));
    } else if (e.touches.length === 1 && zoom > 1 && isDragging) {
      e.preventDefault();
      setPosition({ x: e.touches[0].clientX - dragStart.x, y: e.touches[0].clientY - dragStart.y });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartRef.current && zoom === 1 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - swipeStartRef.current.x;
      const deltaTime = Date.now() - swipeStartRef.current.time;

      if (Math.abs(deltaX) > 50 && deltaTime < 300) {
        if (deltaX > 0 && selectedImageIndex !== null && selectedImageIndex > 0) {
          setSelectedImageIndex(selectedImageIndex - 1);
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        } else if (deltaX < 0 && selectedImageIndex !== null && selectedImageIndex < extractedImages.length - 1) {
          setSelectedImageIndex(selectedImageIndex + 1);
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        }
      }
    }
    
    touchStartRef.current = null;
    swipeStartRef.current = null;
    setIsDragging(false);
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
      setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(prev => Math.min(Math.max(prev + delta, 1), 5));
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

  useEffect(() => {
    if (zoom === 1) setPosition({ x: 0, y: 0 });
  }, [zoom]);

  useEffect(() => {
    return () => {
      if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    };
  }, [cameraStream]);

  useEffect(() => {
    if (extractedImages.length > 0) preloadImages(extractedImages, 20);
  }, [extractedImages]);

  return (
    <div className="min-h-screen bg-gray-50 p-3 pb-safe">
      <div className="max-w-6xl mx-auto space-y-3">
        {/* Header */}
        <div className="bg-white rounded-xl shadow-sm p-4 border border-gray-200">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                ref={inputRef}
                type="text"
                inputMode={isMobile ? "numeric" : "text"}
                placeholder="Enter Product ID"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !loading && handleSearch()}
                disabled={loading}
                className="h-11 pr-10 bg-gray-50 border-gray-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 rounded-lg"
              />
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            </div>
            
            <Button 
              onClick={() => handleSearch()} 
              disabled={loading}
              className="h-11 px-6 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-sm"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Searching
                </>
              ) : (
                'Search'
              )}
            </Button>
            
            <Button 
              onClick={startCamera} 
              variant="outline" 
              className="h-11 px-4 border-gray-300 hover:bg-gray-50 rounded-lg"
              disabled={loading}
            >
              <Camera className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
            <span className="text-sm text-gray-600">
              {extractedImages.length > 0 
                ? `${extractedImages.length} image${extractedImages.length !== 1 ? 's' : ''} found`
                : 'Search JioMart products'
              }
            </span>

            <div className="flex gap-2">
              {jiomartUrl && (
                <Button
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-md"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  View Product
                </Button>
              )}

              <Button
                onClick={() => setShowHistoryDialog(true)}
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-gray-600 hover:text-gray-700 hover:bg-gray-100 rounded-md"
              >
                <History className="h-3 w-3 mr-1" />
                History
              </Button>
            </div>
          </div>
        </div>

        {loading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="aspect-square bg-white rounded-xl border border-gray-200 animate-pulse" />
            ))}
          </div>
        )}

        {extractedImages.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {extractedImages.map((url, index) => (
              <div
                key={index}
                className="relative aspect-square bg-white rounded-xl overflow-hidden cursor-pointer border border-gray-200 hover:border-blue-500 hover:shadow-lg transition-all group"
                onClick={() => {
                  setSelectedImageIndex(index);
                  setZoom(1);
                  setPosition({ x: 0, y: 0 });
                }}
              >
                <img
                  src={url}
                  alt={`Product ${index + 1}`}
                  className="w-full h-full object-contain p-2"
                  loading="lazy"
                />
                <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-md backdrop-blur-sm">
                  {index + 1}
                </div>
                <div className="absolute inset-0 bg-blue-600/0 group-hover:bg-blue-600/5 transition-colors rounded-xl" />
              </div>
            ))}
          </div>
        )}

        {!loading && extractedImages.length === 0 && productId && (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <Search className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600 mb-1">No images found</p>
            <p className="text-sm text-gray-400">Try a different product ID</p>
          </div>
        )}

        {selectedImageIndex !== null && (
          <div
            className="fixed inset-0 bg-black z-50 flex items-center justify-center"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={() => setIsDragging(false)}
            onWheel={handleWheel}
          >
            <img
              src={extractedImages[selectedImageIndex]}
              alt={`Product ${selectedImageIndex + 1}`}
              className="max-w-full max-h-full object-contain"
              style={{
                transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                transition: isDragging ? 'none' : 'transform 0.2s ease-out',
                touchAction: 'none',
                userSelect: 'none'
              }}
              draggable={false}
            />

            <button
              onClick={() => {
                setSelectedImageIndex(null);
                setZoom(1);
                setPosition({ x: 0, y: 0 });
              }}
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md transition-colors"
            >
              <X className="h-5 w-5 text-white" />
            </button>

            {!isMobile && selectedImageIndex > 0 && (
              <button 
                onClick={goToPrevious} 
                className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md transition-colors"
              >
                <ChevronLeft className="h-6 w-6 text-white" />
              </button>
            )}

            {!isMobile && selectedImageIndex < extractedImages.length - 1 && (
              <button 
                onClick={goToNext} 
                className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md transition-colors"
              >
                <ChevronRight className="h-6 w-6 text-white" />
              </button>
            )}

            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full text-sm backdrop-blur-md">
              {selectedImageIndex + 1} / {extractedImages.length}
            </div>

            {zoom > 1 && (
              <div className="absolute top-4 left-4 bg-black/70 text-white px-3 py-1 rounded-full text-sm backdrop-blur-md">
                {(zoom * 100).toFixed(0)}%
              </div>
            )}
          </div>
        )}

        {/* REDESIGNED OCR CAMERA DIALOG */}
        <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
          <DialogContent className="max-w-lg p-0 bg-gradient-to-b from-gray-900 to-black rounded-2xl overflow-hidden border-0">
            {!capturedImage ? (
              <>
                <div className="relative aspect-[3/4] bg-black">
                  <video 
                    ref={videoRef} 
                    autoPlay 
                    playsInline 
                    muted 
                    className="w-full h-full object-cover" 
                  />
                  
                  {/* Scan Frame Overlay */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="relative w-[85%] h-[60%]">
                      {/* Corner Brackets */}
                      <div className="absolute top-0 left-0 w-12 h-12 border-t-4 border-l-4 border-blue-500 rounded-tl-2xl"></div>
                      <div className="absolute top-0 right-0 w-12 h-12 border-t-4 border-r-4 border-blue-500 rounded-tr-2xl"></div>
                      <div className="absolute bottom-0 left-0 w-12 h-12 border-b-4 border-l-4 border-blue-500 rounded-bl-2xl"></div>
                      <div className="absolute bottom-0 right-0 w-12 h-12 border-b-4 border-r-4 border-blue-500 rounded-br-2xl"></div>
                      
                      {/* Scanning Line Animation */}
                      <div className="absolute inset-0 overflow-hidden">
                        <div className="absolute w-full h-1 bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-scan-line"></div>
                      </div>
                    </div>
                  </div>

                  {/* Instructions */}
                  <div className="absolute top-6 left-0 right-0 px-6">
                    <div className="bg-black/60 backdrop-blur-md rounded-xl p-4 border border-white/10">
                      <div className="flex items-start gap-3">
                        <ScanLine className="h-5 w-5 text-blue-400 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-white font-medium text-sm mb-1">Scan Product ID</p>
                          <p className="text-gray-300 text-xs">Position barcode within the frame</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Capture Button */}
                  <div className="absolute bottom-0 left-0 right-0 p-6">
                    <Button 
                      onClick={captureImage} 
                      size="lg"
                      className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-2xl shadow-blue-500/50 border border-blue-400/20"
                    >
                      <Camera className="h-5 w-5 mr-2" />
                      Capture
                    </Button>
                  </div>
                  
                  <canvas ref={canvasRef} className="hidden" />
                </div>
              </>
            ) : (
              <div className="bg-white">
                <div className="relative">
                  <img src={capturedImage} alt="Captured" className="w-full" />
                  {isProcessingOCR && (
                    <div className="absolute inset-0 bg-blue-600/20 backdrop-blur-sm flex items-center justify-center">
                      <div className="bg-white rounded-2xl p-6 shadow-2xl">
                        <Loader2 className="h-10 w-10 animate-spin text-blue-600 mx-auto mb-3" />
                        <p className="text-sm font-medium text-gray-900">Analyzing...</p>
                      </div>
                    </div>
                  )}
                </div>

                {!isProcessingOCR && (
                  <>
                    {detectedIDs.length > 0 ? (
                      <div className="p-5 bg-gradient-to-b from-gray-50 to-white">
                        <div className="flex items-center gap-2 mb-4">
                          <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center">
                            <Search className="h-4 w-4 text-green-600" />
                          </div>
                          <p className="font-semibold text-gray-900">
                            {detectedIDs.length} Product ID{detectedIDs.length !== 1 ? 's' : ''} Found
                          </p>
                        </div>
                        
                        <div className="space-y-2">
                          {detectedIDs.map((id, index) => (
                            <button
                              key={index}
                              onClick={() => useDetectedID(id)}
                              className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl px-5 py-4 font-mono font-bold text-lg transition-all shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40 flex items-center justify-between group"
                            >
                              <span>{id}</span>
                              <Search className="h-5 w-5 group-hover:scale-110 transition-transform" />
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="p-6 bg-gray-50 text-center">
                        <div className="bg-white rounded-xl p-6 border border-gray-200 mb-4">
                          <X className="h-10 w-10 text-gray-300 mx-auto mb-2" />
                          <p className="text-sm text-gray-600">No product IDs detected</p>
                        </div>
                        <Button 
                          onClick={() => { 
                            setCapturedImage(null); 
                            setDetectedIDs([]); 
                            startCamera(); 
                          }} 
                          variant="outline"
                          className="w-full h-11 border-gray-300 rounded-lg"
                        >
                          Try Again
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* History Dialog */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent className="max-w-md bg-white rounded-2xl">
            <div className="border-b border-gray-200 pb-4">
              <DialogTitle className="text-xl font-bold text-gray-900">Search History</DialogTitle>
              <DialogDescription className="text-sm text-gray-600 mt-1">
                Recent product searches
              </DialogDescription>
            </div>

            {searchHistory.length === 0 ? (
              <div className="py-12 text-center">
                <History className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-600 mb-1 font-medium">No history yet</p>
                <p className="text-sm text-gray-400">Your searches will appear here</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {searchHistory.map((item) => (
                  <div 
                    key={item.id} 
                    className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 hover:border-blue-500 hover:bg-blue-50/50 transition-all group"
                  >
                    {item.thumbnail && (
                      <div className="w-12 h-12 bg-gray-100 rounded-lg overflow-hidden border border-gray-200 flex-shrink-0">
                        <img 
                          src={item.thumbnail} 
                          alt={item.productId} 
                          className="w-full h-full object-contain p-1" 
                        />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <p className="font-mono font-bold text-sm text-gray-900 truncate">
                        {item.productId}
                      </p>
                      <p className="text-xs text-gray-500">
                        {new Date(item.timestamp).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </p>
                    </div>

                    <div className="flex gap-1 flex-shrink-0">
                      <Button
                        onClick={() => {
                          setProductId(item.productId);
                          setShowHistoryDialog(false);
                          handleSearch(item.productId);
                        }}
                        size="sm"
                        variant="ghost"
                        className="h-9 w-9 p-0 hover:bg-blue-100 hover:text-blue-700 rounded-lg"
                      >
                        <Search className="h-4 w-4" />
                      </Button>

                      {item.jiomartUrl && (
                        <Button
                          onClick={() => window.open(item.jiomartUrl, '_blank')}
                          size="sm"
                          variant="ghost"
                          className="h-9 w-9 p-0 hover:bg-blue-100 hover:text-blue-700 rounded-lg"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {searchHistory.length > 0 && (
              <div className="pt-4 border-t border-gray-200">
                <Button
                  onClick={() => {
                    setSearchHistory([]);
                    localStorage.removeItem('searchHistory');
                    toast.success('History cleared');
                  }}
                  variant="outline"
                  size="sm"
                  className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300 rounded-lg"
                >
                  Clear All History
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      <style jsx>{`
        @keyframes scan-line {
          0% { top: 0; }
          100% { top: 100%; }
        }
        .animate-scan-line {
          animation: scan-line 2s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
};
