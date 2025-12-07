import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Camera, ExternalLink, History, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
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

// ==================== ROBUST IMAGE EXTRACTOR ====================
// Extracts ALL product and legal images from JioMart using multiple URL patterns
const extractAllProductImages = async (productId: string, sampleUrl?: string): Promise<string[]> => {
  const validImages: string[] = [];
  const checkPromises: Promise<string | null>[] = [];
  
  // Helper function to check if image exists
  const checkImage = (url: string): Promise<string | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      const timeout = setTimeout(() => {
        img.src = '';
        resolve(null);
      }, 400);
      
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

  // Pattern 1: Direct format (most common)
  // https://www.jiomart.com/images/product/original/PRODUCTID/PRODUCTID-{product-images|legal-images}-{index}.jpg
  for (let i = 0; i < 40; i++) {
    checkPromises.push(
      checkImage(`https://www.jiomart.com/images/product/original/${productId}/${productId}-product-images-${i}.jpg`)
    );
    checkPromises.push(
      checkImage(`https://www.jiomart.com/images/product/original/${productId}/${productId}-legal-images-${i}.jpg`)
    );
  }

  // Pattern 2: With additional codes (from sample URL if available)
  if (sampleUrl) {
    const match = sampleUrl.match(/\/images\/product\/(\d+x\d+|original)\/(\d+)\/([^\/]+)-(product-images|legal-images)-([^-]+)-p(\d+)-(\d+)-(\d+)\.jpg/);
    
    if (match) {
      const [, resolution, pid, name, , productCode, pNumber, , timestamp] = match;
      
      for (let i = 0; i < 40; i++) {
        checkPromises.push(
          checkImage(`https://www.jiomart.com/images/product/original/${pid}/${name}-product-images-${productCode}-p${pNumber}-${i}-${timestamp}.jpg`)
        );
        checkPromises.push(
          checkImage(`https://www.jiomart.com/images/product/original/${pid}/${name}-legal-images-${productCode}-p${pNumber}-${i}-${timestamp}.jpg`)
        );
      }
    }
  }

  // Pattern 3: Alternative format without index
  checkPromises.push(
    checkImage(`https://www.jiomart.com/images/product/original/${productId}/${productId}.jpg`)
  );

  // Execute all checks in parallel
  const results = await Promise.all(checkPromises);
  
  // Filter valid images and remove duplicates
  const uniqueImages = new Set(results.filter((url): url is string => url !== null));
  
  return Array.from(uniqueImages);
};

// Preload images for better UX
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

  // Zoom/Pan states
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

  // Initialize - Load history
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

    // Reset API keys every hour
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
      if (!apiKey) throw new Error('All API keys exhausted. Please try again later.');

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

        throw new Error(errorData.error?.message || `Request failed: ${response.status}`);
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
      
      // Fetch product URL and sample images from Google
      const [webResponse, imageResponse] = await Promise.all([
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=1&fields=items(link)`
        ),
        fetchWithRetry((apiKey) =>
          `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&searchType=image&num=3&fields=items(link)`
        )
      ]);

      const [webData, imageData] = await Promise.all([
        webResponse.json(),
        imageResponse.json()
      ]);

      // Get JioMart product URL
      let foundUrl = '';
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        foundUrl = webData.items[0].link;
        setJiomartUrl(foundUrl);
      }

      // Get sample image URL for pattern extraction
      const sampleImageUrl = imageData.items?.[0]?.link?.includes('jiomart.com/images/product') 
        ? imageData.items[0].link 
        : undefined;

      // Extract all images using multiple patterns
      const images = await extractAllProductImages(idToSearch, sampleImageUrl);
      
      if (images.length > 0) {
        setExtractedImages(images);
        preloadImages(images, 20);
        saveToHistory(idToSearch, foundUrl, images[0]);
        toast.success(`Found ${images.length} image${images.length !== 1 ? 's' : ''}`);
      } else {
        toast.error('No images found for this product ID');
      }
    } catch (error: any) {
      console.error('Search error:', error);
      
      if (error.message.includes('exhausted')) {
        toast.error('API limit reached. Please try again in an hour.');
      } else if (error.message.includes('network') || error.message.includes('fetch')) {
        toast.error('Network error. Please check your connection.');
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
        video: { 
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
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
      // Compress image for OCR
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
      
      // OCR API call
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
        throw new Error(result.ErrorMessage?.[0] || 'OCR processing failed');
      }

      // Extract product IDs from OCR text
      const extractedText = result.ParsedResults?.[0]?.ParsedText || '';
      const foundIDs = new Set<string>();
      const fullText = extractedText.replace(/\n/g, ' ');

      // Clean common OCR mistakes
      const cleanedText = fullText
        .replace(/[oO]/g, '0')
        .replace(/[lI|]/g, '1')
        .replace(/[sS]/g, '5')
        .replace(/[bB]/g, '8');

      // Pattern matching for product IDs
      const idPatterns = [
        /ID\s*[:：.,-]?\s*(\d{5,})/gi,
        /Product\s*[:：.,-]?\s*(\d{5,})/gi,
        /Item\s*[:：.,-]?\s*(\d{5,})/gi,
        /Code\s*[:：.,-]?\s*(\d{5,})/gi,
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

      // Fallback: extract any number sequences
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
      toast.error('Failed to extract text. Please try again.');
    } finally {
      setIsProcessingOCR(false);
    }
  };

  const useDetectedID = (id: string) => {
    setProductId(id);
    stopCamera();
    setTimeout(() => handleSearch(id), 50);
  };

  // Touch/Mouse handlers for zoom/pan
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
      swipeStartRef.current = { 
        x: e.touches[0].clientX, 
        y: e.touches[0].clientY, 
        time: Date.now() 
      };
      if (zoom > 1) {
        setIsDragging(true);
        setDragStart({ 
          x: e.touches[0].clientX - position.x, 
          y: e.touches[0].clientY - position.y 
        });
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

  // Cleanup effects
  useEffect(() => {
    if (zoom === 1) setPosition({ x: 0, y: 0 });
  }, [zoom]);

  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [cameraStream]);

  useEffect(() => {
    if (extractedImages.length > 0) {
      preloadImages(extractedImages, 20);
    }
  }, [extractedImages]);

  return (
    <div className="min-h-screen bg-gray-50 p-3 pb-safe">
      <div className="max-w-6xl mx-auto space-y-3">
        {/* Header */}
        <div className="bg-white rounded-lg shadow-sm p-3 border border-gray-200">
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
                className="h-11 pr-10 bg-gray-50 border-gray-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            </div>
            
            <Button 
              onClick={() => handleSearch()} 
              disabled={loading}
              className="h-11 px-6 bg-blue-600 hover:bg-blue-700 text-white font-medium"
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
              className="h-11 px-4 border-gray-300 hover:bg-gray-50"
              disabled={loading}
            >
              <Camera className="h-4 w-4" />
            </Button>
          </div>

          {/* Info Bar */}
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
            <span className="text-sm text-gray-600">
              {extractedImages.length > 0 
                ? `${extractedImages.length} image${extractedImages.length !== 1 ? 's' : ''} found`
                : 'Enter product ID to search'
              }
            </span>

            <div className="flex gap-2">
              {jiomartUrl && (
                <Button
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  View on JioMart
                </Button>
              )}

              <Button
                onClick={() => setShowHistoryDialog(true)}
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-gray-600 hover:text-gray-700 hover:bg-gray-100"
              >
                <History className="h-3 w-3 mr-1" />
                History
              </Button>
            </div>
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="aspect-square bg-white rounded-lg border border-gray-200 animate-pulse" />
            ))}
          </div>
        )}

        {/* Image Grid */}
        {extractedImages.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {extractedImages.map((url, index) => (
              <div
                key={index}
                className="relative aspect-square bg-white rounded-lg overflow-hidden cursor-pointer border border-gray-200 hover:border-blue-500 hover:shadow-md transition-all group"
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
                <div className="absolute inset-0 bg-blue-500/0 group-hover:bg-blue-500/5 transition-colors" />
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && extractedImages.length === 0 && productId && (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Search className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600 mb-1">No images found</p>
            <p className="text-sm text-gray-400">Try a different product ID</p>
          </div>
        )}

        {/* Fullscreen Viewer */}
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

            {/* Close Button */}
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

            {/* Navigation Arrows - Desktop */}
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

            {/* Counter */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full text-sm backdrop-blur-md">
              {selectedImageIndex + 1} / {extractedImages.length}
            </div>

            {/* Zoom Indicator */}
            {zoom > 1 && (
              <div className="absolute top-4 left-4 bg-black/70 text-white px-3 py-1 rounded-full text-sm backdrop-blur-md">
                {(zoom * 100).toFixed(0)}%
              </div>
            )}
          </div>
        )}

        {/* Camera Dialog */}
        <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
          <DialogContent className="max-w-lg p-0 bg-white rounded-xl overflow-hidden">
            <div className="p-4 bg-gray-50 border-b border-gray-200">
              <DialogTitle className="text-lg font-semibold text-gray-900">Scan Product ID</DialogTitle>
              <DialogDescription className="text-sm text-gray-600 mt-1">
                Position the product ID within the frame
              </DialogDescription>
            </div>

            {!capturedImage ? (
              <div className="relative aspect-video bg-black">
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="w-full h-full object-cover" 
                />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="border-2 border-white/80 rounded-xl w-4/5 h-3/5 shadow-lg"></div>
                </div>
                <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
                  <Button 
                    onClick={captureImage} 
                    size="lg"
                    className="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-lg"
                  >
                    <Camera className="h-5 w-5 mr-2" />
                    Capture Image
                  </Button>
                </div>
                <canvas ref={canvasRef} className="hidden" />
              </div>
            ) : (
              <div>
                <img src={capturedImage} alt="Captured" className="w-full" />

                {isProcessingOCR ? (
                  <div className="p-8 text-center bg-gray-50">
                    <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto mb-3" />
                    <p className="text-sm text-gray-600">Processing image...</p>
                  </div>
                ) : detectedIDs.length > 0 ? (
                  <div className="p-4 space-y-2 bg-gray-50">
                    <p className="text-sm font-medium text-gray-700 mb-3">
                      {detectedIDs.length} Product ID{detectedIDs.length !== 1 ? 's' : ''} Detected
                    </p>
                    {detectedIDs.map((id, index) => (
                      <button
                        key={index}
                        onClick={() => useDetectedID(id)}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-3 font-mono font-medium transition-colors flex items-center justify-between shadow-sm"
                      >
                        <span className="text-lg">{id}</span>
                        <Search className="h-5 w-5" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 bg-gray-50">
                    <p className="text-sm text-gray-600 text-center mb-3">No product IDs detected</p>
                    <Button 
                      onClick={() => { 
                        setCapturedImage(null); 
                        setDetectedIDs([]); 
                        startCamera(); 
                      }} 
                      variant="outline"
                      className="w-full h-10 border-gray-300"
                    >
                      Retake Photo
                    </Button>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* History Dialog */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent className="max-w-md bg-white rounded-xl">
            <div className="border-b border-gray-200 pb-3">
              <DialogTitle className="text-lg font-semibold text-gray-900">Search History</DialogTitle>
              <DialogDescription className="text-sm text-gray-600 mt-1">
                Your recent product searches
              </DialogDescription>
            </div>

            {searchHistory.length === 0 ? (
              <div className="py-12 text-center">
                <History className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-600 mb-1">No history yet</p>
                <p className="text-sm text-gray-400">Your searches will appear here</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {searchHistory.map((item) => (
                  <div 
                    key={item.id} 
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-blue-500 hover:bg-blue-50/50 transition-all group"
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
                      <p className="font-mono font-semibold text-sm text-gray-900 truncate">
                        {item.productId}
                      </p>
                      <p className="text-xs text-gray-500">
                        {new Date(item.timestamp).toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
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
                        className="h-9 w-9 p-0 hover:bg-blue-100 hover:text-blue-700"
                      >
                        <Search className="h-4 w-4" />
                      </Button>

                      {item.jiomartUrl && (
                        <Button
                          onClick={() => window.open(item.jiomartUrl, '_blank')}
                          size="sm"
                          variant="ghost"
                          className="h-9 w-9 p-0 hover:bg-blue-100 hover:text-blue-700"
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
              <div className="pt-3 border-t border-gray-200">
                <Button
                  onClick={() => {
                    setSearchHistory([]);
                    localStorage.removeItem('searchHistory');
                    toast.success('History cleared');
                  }}
                  variant="outline"
                  size="sm"
                  className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
                >
                  Clear All History
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
