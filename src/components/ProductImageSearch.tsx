import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, Camera, ExternalLink, History, ChevronLeft, ChevronRight } from 'lucide-react';
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

// ==================== ULTRA-FAST IMAGE EXTRACTOR ====================
const checkImageExists = async (url: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => {
      img.src = '';
      resolve(false);
    }, 250); // Ultra-fast timeout
    
    img.onload = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    
    img.src = url;
  });
};

const parseJiomartUrl = (url: string) => {
  try {
    const regex = /https:\/\/www\.jiomart\.com\/images\/product\/(\d+x\d+|original)\/(\d+)\/([^\/]+)-(product-images|legal-images)-([^-]+)-p(\d+)-(\d+)-(\d+)\.jpg/;
    const match = url.match(regex);
    if (!match) return null;
    
    return {
      baseUrl: 'https://www.jiomart.com/images/product',
      resolution: match[1],
      productId: match[2],
      name: match[3],
      imageType: match[4] as 'product-images' | 'legal-images',
      productCode: match[5],
      pNumber: match[6],
      index: parseInt(match[7]),
      timestamp: match[8]
    };
  } catch {
    return null;
  }
};

const buildImageUrl = (
  parts: ReturnType<typeof parseJiomartUrl>,
  imageType: 'product-images' | 'legal-images',
  index: number
): string => {
  if (!parts) return '';
  return `${parts.baseUrl}/original/${parts.productId}/${parts.name}-${imageType}-${parts.productCode}-p${parts.pNumber}-${index}-${parts.timestamp}.jpg`;
};

// ⚡ ULTRA-FAST: Extract ALL images with aggressive parallel processing
const extractAllProductImages = async (firstImageUrl: string): Promise<string[]> => {
  const parts = parseJiomartUrl(firstImageUrl);
  if (!parts) return [];

  const MAX_CHECKS = 20; // Check more images
  
  // Generate ALL possible URLs
  const allUrls = [
    ...Array.from({ length: MAX_CHECKS }, (_, i) => buildImageUrl(parts, 'product-images', i)),
    ...Array.from({ length: MAX_CHECKS }, (_, i) => buildImageUrl(parts, 'legal-images', i))
  ];

  // ⚡ Check ALL images in parallel (no batching)
  const results = await Promise.all(
    allUrls.map(async (url) => ({
      url,
      exists: await checkImageExists(url)
    }))
  );

  let validImages = results.filter(r => r.exists).map(r => r.url);

  // Fallback: try next pNumber if nothing found
  if (validImages.length === 0) {
    const modifiedParts = { ...parts, pNumber: (parseInt(parts.pNumber) + 1).toString() };
    const fallbackUrls = Array.from({ length: 10 }, (_, i) => 
      buildImageUrl(modifiedParts, 'product-images', i)
    );
    const fallbackResults = await Promise.all(
      fallbackUrls.map(async (url) => ({ url, exists: await checkImageExists(url) }))
    );
    validImages = fallbackResults.filter(r => r.exists).map(r => r.url);
  }

  return validImages;
};

// ⚡ Preload images for instant display
const preloadImages = (urls: string[], limit: number = 15) => {
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
  const [isAutoLoading, setIsAutoLoading] = useState(false);

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
  const currentSearchIdRef = useRef('');
  const processedLinksRef = useRef<Set<string>>(new Set());
  
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );
  const currentKeyIndexRef = useRef(0);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Initialize
  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      try {
        const parsed = JSON.parse(savedHistory);
        setSearchHistory(Array.isArray(parsed) ? parsed : []);
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
    let lastError: Error | null = null;

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

        throw new Error(errorData.error?.message || `Request failed: ${response.status}`);
      } catch (error: any) {
        lastError = error;
        if (error.message.includes('fetch') || error.message.includes('network')) {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, 300));
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error('All API keys failed');
  };

  const saveToHistory = useCallback((productId: string, jiomartUrl?: string, thumbnail?: string) => {
    if (!productId?.trim()) return;

    setSearchHistory((prev) => {
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
    });
  }, []);

  // ⚡ ULTRA-FAST: Load ALL images in parallel (no batching)
  const loadAllImagesSimultaneously = useCallback(async (links: string[], searchId: string) => {
    setIsAutoLoading(true);

    // ⚡ Process ALL links in parallel
    const results = await Promise.allSettled(
      links.map(async (link) => {
        if (processedLinksRef.current.has(link)) return [];
        
        try {
          const images = await Promise.race([
            extractAllProductImages(link),
            new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500))
          ]);
          
          processedLinksRef.current.add(link);
          return Array.isArray(images) ? images : [];
        } catch {
          processedLinksRef.current.add(link);
          return [];
        }
      })
    );

    const newImages = results
      .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    if (newImages.length > 0 && searchId === currentSearchIdRef.current) {
      setExtractedImages(prev => {
        const combined = [...prev, ...newImages];
        const unique = Array.from(new Set(combined));
        return [
          ...unique.filter(url => url.includes('/original/')),
          ...unique.filter(url => !url.includes('/original/'))
        ];
      });
    }

    setIsAutoLoading(false);
  }, []);

  const handleSearch = useCallback(async (searchId?: string) => {
    const idToSearch = searchId || productId;
    if (!idToSearch.trim()) {
      toast.error('Enter product ID');
      return;
    }

    if (!GOOGLE_SEARCH_ENGINE_ID) {
      toast.error('Search not configured');
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
          .filter((url: string) => url?.includes('jiomart.com/images/product'))
      )) as string[];

      if (!jiomartLinks.length) {
        toast.error('No product images found');
        return;
      }

      // ⚡ Load first link immediately
      const firstLink = jiomartLinks[0];
      try {
        const firstImages = await extractAllProductImages(firstLink);
        processedLinksRef.current.add(firstLink);
        
        if (firstImages.length > 0) {
          setExtractedImages(firstImages);
          preloadImages(firstImages, 15);
          setTimeout(() => saveToHistory(idToSearch, foundUrl, firstImages[0]), 100);
        }
      } catch {
        processedLinksRef.current.add(firstLink);
      }

      // ⚡ Load ALL remaining images in parallel
      const remainingLinks = jiomartLinks.slice(1);
      if (remainingLinks.length > 0) {
        setTimeout(() => loadAllImagesSimultaneously(remainingLinks, newSearchId), 100);
      }

      toast.success('Loading images...');
    } catch (error: any) {
      console.error('Search error:', error);
      if (error.message.includes('exhausted')) {
        toast.error('API limit reached. Try again later.');
      } else {
        toast.error(error.message || 'Search failed');
      }
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, fetchWithRetry, loadAllImagesSimultaneously]);

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
        /Product\s*[:：.,-]?\s*(\d{5,})/gi,
        /Item\s*[:：.,-]?\s*(\d{5,})/gi,
      ];

      for (const pattern of idPatterns) {
        const matches = [...fullText.matchAll(pattern), ...cleanedText.matchAll(pattern)];
        matches.forEach(m => m[1] && foundIDs.add(m[1].replace(/\D/g, '')));
      }

      if (foundIDs.size === 0) {
        const numberMatches = [...fullText.matchAll(/\b(\d{6,12})\b/g)];
        numberMatches.forEach(m => m[1] && foundIDs.add(m[1]));
      }

      const uniqueIDs = Array.from(foundIDs).filter(id => id.length >= 6 && id.length <= 12);
      setDetectedIDs(uniqueIDs);

      if (uniqueIDs.length === 0) {
        toast.info('No IDs detected');
      } else {
        const firstID = uniqueIDs[0];
        setProductId(firstID);
        stopCamera();
        toast.success(`Found ${uniqueIDs.length} ID(s)`);
        setTimeout(() => handleSearch(firstID), 100);
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
    if (extractedImages.length > 0) preloadImages(extractedImages, 15);
  }, [extractedImages]);

  return (
    <div className="min-h-screen bg-white p-3">
      <div className="max-w-6xl mx-auto space-y-3">
        {/* Search Bar */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              ref={inputRef}
              type="text"
              inputMode={isMobile ? "numeric" : "text"}
              placeholder="Product ID"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="h-10 pr-10 border-gray-300"
            />
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          </div>
          
          <Button onClick={() => handleSearch()} disabled={loading} className="h-10 px-5 bg-black text-white hover:bg-gray-800">
            {loading ? '...' : 'Find'}
          </Button>
          
          <Button onClick={startCamera} variant="outline" className="h-10 px-3 border-gray-300">
            <Camera className="h-4 w-4" />
          </Button>
        </div>

        {/* Info Bar */}
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            {extractedImages.length > 0 && `${extractedImages.length} images`}
            {isAutoLoading && <span className="ml-2">loading...</span>}
          </span>

          <div className="flex gap-2">
            {jiomartUrl && (
              <Button
                onClick={() => window.open(jiomartUrl, '_blank')}
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
              >
                <ExternalLink className="h-3 w-3 mr-1" />
                Open
              </Button>
            )}

            <Button
              onClick={() => setShowHistoryDialog(true)}
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
            >
              <History className="h-3 w-3 mr-1" />
              History
            </Button>
          </div>
        </div>

        {/* Loading Skeleton */}
        {loading && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
            {[...Array(10)].map((_, i) => (
              <div key={i} className="aspect-square bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        )}

        {/* Image Grid */}
        {extractedImages.length > 0 && (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
            {extractedImages.map((url, index) => (
              <div
                key={index}
                className="relative aspect-square bg-gray-50 rounded overflow-hidden cursor-pointer border border-gray-200 hover:border-black transition"
                onClick={() => {
                  setSelectedImageIndex(index);
                  setZoom(1);
                  setPosition({ x: 0, y: 0 });
                }}
              >
                <img
                  src={url}
                  alt={`${index + 1}`}
                  className="w-full h-full object-contain"
                  loading="lazy"
                />
                <div className="absolute bottom-1 right-1 bg-black/70 text-white text-xs px-1.5 py-0.5 rounded">
                  {index + 1}
                </div>
              </div>
            ))}
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
              alt={`${selectedImageIndex + 1}`}
              className="max-w-full max-h-full object-contain"
              style={{
                transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                transition: isDragging ? 'none' : 'transform 0.2s',
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
              className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur"
            >
              <X className="h-5 w-5 text-white" />
            </button>

            {!isMobile && selectedImageIndex > 0 && (
              <button onClick={goToPrevious} className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur">
                <ChevronLeft className="h-5 w-5 text-white" />
              </button>
            )}

            {!isMobile && selectedImageIndex < extractedImages.length - 1 && (
              <button onClick={goToNext} className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur">
                <ChevronRight className="h-5 w-5 text-white" />
              </button>
            )}

            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-3 py-1 rounded-full text-sm backdrop-blur">
              {selectedImageIndex + 1} / {extractedImages.length}
            </div>

            {zoom > 1 && (
              <div className="absolute top-4 left-4 bg-black/70 text-white px-2 py-1 rounded-full text-xs backdrop-blur">
                {(zoom * 100).toFixed(0)}%
              </div>
            )}
          </div>
        )}

        {/* Camera Dialog */}
        <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
          <DialogContent className="max-w-lg p-0">
            <DialogTitle>Scan Product</DialogTitle>
            <DialogDescription>Capture product ID</DialogDescription>

            {!capturedImage ? (
              <div className="relative aspect-video bg-black">
                <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <div className="border-2 border-white/50 rounded w-3/4 h-2/3"></div>
                  <p className="text-white text-sm mt-4 bg-black/50 px-3 py-1 rounded-full">Position ID in frame</p>
                </div>
                <Button onClick={captureImage} size="lg" className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full h-14 w-14 p-0 bg-white">
                  <Camera className="h-6 w-6 text-black" />
                </Button>
                <canvas ref={canvasRef} className="hidden" />
              </div>
            ) : (
              <div className="relative">
                <img src={capturedImage} alt="Captured" className="w-full" />

                {isProcessingOCR ? (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <p className="text-white">Processing...</p>
                  </div>
                ) : detectedIDs.length > 0 ? (
                  <div className="p-4 space-y-2">
                    <h3 className="font-medium text-sm">Detected IDs</h3>
                    {detectedIDs.map((id, index) => (
                      <button
                        key={index}
                        onClick={() => useDetectedID(id)}
                        className="w-full bg-black text-white rounded px-3 py-2 font-mono text-sm hover:bg-gray-800 flex items-center justify-between"
                      >
                        <span>{id}</span>
                        <Search className="h-4 w-4" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <Button onClick={() => { setCapturedImage(null); setDetectedIDs([]); startCamera(); }} className="w-full mt-2">
                    Retake
                  </Button>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* History Dialog */}
        <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
          <DialogContent className="max-w-md">
            <DialogTitle>History</DialogTitle>
            <DialogDescription>Recent searches</DialogDescription>

            {searchHistory.length === 0 ? (
              <p className="text-center text-gray-500 py-8 text-sm">No history</p>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {searchHistory.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 p-2 rounded border hover:bg-gray-50">
                    {item.thumbnail && (
                      <img src={item.thumbnail} alt={item.productId} className="w-10 h-10 object-cover rounded" />
                    )}

                    <div className="flex-1 min-w-0">
                      <p className="font-mono font-medium text-sm truncate">{item.productId}</p>
                      <p className="text-xs text-gray-500">{new Date(item.timestamp).toLocaleString()}</p>
                    </div>

                    <div className="flex gap-1">
                      <Button
                        onClick={() => {
                          setProductId(item.productId);
                          setShowHistoryDialog(false);
                          handleSearch(item.productId);
                        }}
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                      >
                        <Search className="h-4 w-4" />
                      </Button>

                      {item.jiomartUrl && (
                        <Button
                          onClick={() => window.open(item.jiomartUrl, '_blank')}
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
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
              <Button
                onClick={() => {
                  setSearchHistory([]);
                  localStorage.removeItem('searchHistory');
                  toast.success('Cleared');
                }}
                variant="outline"
                size="sm"
                className="w-full"
              >
                Clear All
              </Button>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};
