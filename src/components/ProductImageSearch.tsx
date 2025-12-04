import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Search, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Scan, ExternalLink, History, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { toast } from 'sonner';
import { extractAllProductImages } from '@/lib/imageExtractor';
import { GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_SPACE_API_KEY = 'K86120042088957';

// ✅ ADD YOUR MULTIPLE API KEYS HERE
const GOOGLE_API_KEYS = [
  'AIzaSyCUb-RrSjsScT_gfhmdyOMVp3ZHSSsai1U',
  'AIzaSyDVvxwYZzZAOLy5Cd3FMNrQKcxZxldsJCY',
  'AIzaSyBdRbGEG_nLOhaI1_RpNTN6kiwhEVcuxXo',
  'AIzaSyDsTLL2TqDbV2DhXEwxny_5VIb1IjmQVn0',
  'AIzaSyC0RGsJ8Q0Ery9CjyLBEp25REWV_SqpQPE',
  'AIzaSyB5tGVlcRpnrRkfrttWo4kMK1-9PGj15y4'
];

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

interface ApiKeyStatus {
  key: string;
  exhausted: boolean;
  lastReset: number;
}

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const [imageLoadKey, setImageLoadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
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
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // ✅ Progressive loading state
  const processedLinksRef = useRef<Set<string>>(new Set());
  const pendingLinksRef = useRef<string[]>([]);
  const currentSearchIdRef = useRef<string>('');
  
  // ✅ API Key rotation state
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );
  const currentKeyIndexRef = useRef(0);

  // Load search history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem('searchHistory');
    if (savedHistory) {
      try {
        setSearchHistory(JSON.parse(savedHistory));
      } catch {
        localStorage.removeItem('searchHistory');
      }
    }

    // Reset exhausted API keys every hour
    const resetInterval = setInterval(() => {
      setApiKeyStatuses(prev => 
        prev.map(status => ({
          ...status,
          exhausted: false,
          lastReset: Date.now()
        }))
      );
    }, 3600000);

    return () => clearInterval(resetInterval);
  }, []);

  // ✅ Get next available API key with rotation
  const getNextApiKey = useCallback((): string | null => {
    const availableKeys = apiKeyStatuses.filter(k => !k.exhausted);
    
    if (availableKeys.length === 0) {
      return null;
    }

    const key = availableKeys[currentKeyIndexRef.current % availableKeys.length];
    currentKeyIndexRef.current++;
    
    return key.key;
  }, [apiKeyStatuses]);

  // ✅ Mark API key as exhausted
  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses(prev =>
      prev.map(status =>
        status.key === apiKey
          ? { ...status, exhausted: true }
          : status
      )
    );
  }, []);

  // ✅ Fetch with automatic API key rotation
  const fetchWithRetry = async (
    buildUrl: (apiKey: string) => string,
    maxRetries: number = GOOGLE_API_KEYS.length
  ): Promise<Response> => {
    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < maxRetries) {
      const apiKey = getNextApiKey();
      
      if (!apiKey) {
        throw new Error('All API keys exhausted. Please try again later.');
      }

      try {
        const url = buildUrl(apiKey);
        const response = await fetch(url);

        if (response.ok) {
          return response;
        }

        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || '';
        
        const isRateLimitError = 
          response.status === 429 ||
          errorMessage.toLowerCase().includes('quota') ||
          errorMessage.toLowerCase().includes('limit') ||
          errorMessage.toLowerCase().includes('ratelimitexceeded') ||
          errorData.error?.code === 429;

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

  // Save search to history
  const saveToHistory = useCallback((productId: string, jiomartUrl?: string) => {
    setSearchHistory((prevHistory) => {
      const newHistoryItem: SearchHistoryItem = {
        id: Date.now().toString(),
        productId,
        timestamp: Date.now(),
        jiomartUrl
      };
      
      const updatedHistory = [newHistoryItem, ...prevHistory].slice(0, 20);
      localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
      return updatedHistory;
    });
  }, []);

  // ✅ Progressive image extraction
  const extractImagesProgressively = useCallback(async (
    links: string[], 
    searchId: string
  ) => {
    if (searchId !== currentSearchIdRef.current) return;

    const batchSize = 4; // Process 4 links at a time
    
    for (let i = 0; i < links.length; i += batchSize) {
      if (searchId !== currentSearchIdRef.current) break;

      const batch = links.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map(async (link) => {
          if (processedLinksRef.current.has(link)) return [];
          
          try {
            const images = await Promise.race([
              extractAllProductImages(link),
              new Promise<string[]>((_, reject) => 
                setTimeout(() => reject(new Error('timeout')), 6000)
              )
            ]);
            
            processedLinksRef.current.add(link);
            return Array.isArray(images) ? images : [];
          } catch (error) {
            processedLinksRef.current.add(link);
            return [];
          }
        })
      );

      // Collect new images
      const newImages: string[] = [];
      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
          newImages.push(...result.value);
        }
      });

      // Update images
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

      // Small delay between batches
      if (i + batchSize < links.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }, []);

  // ✅ Load more images
  const loadMoreImages = useCallback(async () => {
    if (isLoadingMore || pendingLinksRef.current.length === 0) return;

    setIsLoadingMore(true);
    const remainingLinks = pendingLinksRef.current.filter(
      link => !processedLinksRef.current.has(link)
    );

    if (remainingLinks.length > 0) {
      await extractImagesProgressively(
        remainingLinks.slice(0, 5),
        currentSearchIdRef.current
      );
    }

    setIsLoadingMore(false);
  }, [isLoadingMore, extractImagesProgressively]);

  // ✅ MAIN SEARCH HANDLER - Integrated with API rotation and progressive loading
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

    const startTime = performance.now();
    setLoading(true);
    setExtractedImages([]);
    setLoadedImages(new Set());
    setJiomartUrl('');
    setSearchTime(null);
    setImageLoadKey(prev => prev + 1);
    processedLinksRef.current.clear();
    pendingLinksRef.current = [];
    
    try {
      const query = `site:jiomart.com ${idToSearch}`;
      
      // ✅ Parallel API calls with automatic retry
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
      
      // Extract JioMart URL
      let foundUrl = '';
      if (webData.items?.[0]?.link?.includes('jiomart.com')) {
        foundUrl = webData.items[0].link;
        setJiomartUrl(foundUrl);
      }
      
      saveToHistory(idToSearch, foundUrl);
      
      if (!imageData.items?.length) {
        toast.error('No images found');
        setSearchTime((performance.now() - startTime) / 1000);
        return;
      }

      // Get unique JioMart image links
      const jiomartLinks = Array.from(new Set(
        imageData.items
          .map((item: any) => item.link)
          .filter((url: string) => url.includes('jiomart.com/images/product'))
      )) as string[];

      if (!jiomartLinks.length) {
        toast.error('No product images found');
        setSearchTime((performance.now() - startTime) / 1000);
        return;
      }

      pendingLinksRef.current = [...jiomartLinks];

      // ✅ Start progressive extraction
      const firstBatch = jiomartLinks.slice(0, 5);
      const remainingLinks = jiomartLinks.slice(5);
      
      await extractImagesProgressively(firstBatch, newSearchId);

      // Continue with remaining in background
      if (remainingLinks.length > 0 && newSearchId === currentSearchIdRef.current) {
        setTimeout(() => {
          extractImagesProgressively(remainingLinks, newSearchId);
        }, 500);
      }

      setSearchTime((performance.now() - startTime) / 1000);
      toast.success('Loading images...');
      
    } catch (error: any) {
      console.error('Search error:', error);
      
      if (error.message.includes('exhausted')) {
        toast.error('All API keys exhausted. Please try again in an hour.');
      } else {
        toast.error(error.message || 'Search failed. Try again.');
      }
      
      setSearchTime((performance.now() - startTime) / 1000);
    } finally {
      setLoading(false);
    }
  }, [productId, saveToHistory, extractImagesProgressively, getNextApiKey, markApiKeyExhausted, fetchWithRetry]);

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
    setExtractedText('');
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
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const imageData = canvas.toDataURL('image/jpeg', 0.9);
    setCapturedImage(imageData);
    
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      setCameraStream(null);
    }

    await extractTextFromImage(imageData);
  };

  const retakePhoto = () => {
    setCapturedImage(null);
    setExtractedText('');
    setDetectedIDs([]);
    setSelectableTexts([]);
    startCamera();
  };

  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);
    
    try {
      const img = new Image();
      img.src = imageData;
      await new Promise((resolve) => { img.onload = resolve; });
      
      const canvas = document.createElement('canvas');
      const maxDimension = 600;
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
      }
      
      const compressedImage = canvas.toDataURL('image/jpeg', 0.6);

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

      if (!response.ok) {
        throw new Error('OCR failed');
      }

      const result = await response.json();
      
      if (result.IsErroredOnProcessing) {
        throw new Error(result.ErrorMessage?.[0] || 'OCR failed');
      }

      const extractedText = result.ParsedResults?.[0]?.ParsedText || '';
      setExtractedText(extractedText);
      
      const words = extractedText.split(/\s+/).filter(w => w.trim());
      const selectable = words.map((word) => ({
        text: word.trim(),
        isNumber: /\d{6,}/.test(word) || /\d/.test(word)
      }));
      
      setSelectableTexts(selectable);
      
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
        const numberMatches = [...fullText.matchAll(/\b(\d{6,12})\b/g), ...cleanedText.matchAll(/\b(\d{6,12})\b/g)];
        numberMatches.forEach(m => m[1] && foundIDs.add(m[1]));
      }
      
      if (foundIDs.size === 0) {
        const separatedNumbers = fullText.match(/\d[\d\s\-_.]{4,}\d/g) || [];
        separatedNumbers.forEach(num => {
          const cleaned = num.replace(/\D/g, '');
          if (cleaned.length >= 6) foundIDs.add(cleaned);
        });
      }
      
      const uniqueIDs = Array.from(foundIDs).filter(id => id.length >= 6 && id.length <= 12);
      setDetectedIDs(uniqueIDs);
      
      if (uniqueIDs.length === 0) {
        toast.info('No IDs detected. Tap any text.');
      } else {
        toast.success(`Found ${uniqueIDs.length} ID(s)`);
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
        <Button onClick={() => handleSearch()} disabled={loading}>
          <Search className="w-4 h-4 mr-2" />
          {loading ? 'Finding...' : 'Find'}
        </Button>
      </div>

      {/* Loading Skeletons */}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <div className="columns-2 sm:columns-3 md:columns-4 gap-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="mb-3 break-inside-avoid">
                <Skeleton className="w-full aspect-square rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Extracted Images Grid */}
      {extractedImages.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-medium">Product Images ({extractedImages.length})</h3>
              {searchTime !== null && (
                <span className="text-xs text-muted-foreground">
                  {searchTime.toFixed(2)}s
                </span>
              )}
              {(loading || isLoadingMore) && (
                <span className="text-xs text-primary flex items-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  Loading...
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {/* Load More Button */}
              {pendingLinksRef.current.length > processedLinksRef.current.size && !loading && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMoreImages}
                  disabled={isLoadingMore}
                  className="gap-2"
                >
                  <RefreshCw className={`w-4 h-4 ${isLoadingMore ? 'animate-spin' : ''}`} />
                  Load More
                </Button>
              )}
              {jiomartUrl && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => window.open(jiomartUrl, '_blank')}
                  className="gap-2"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Product
                </Button>
              )}
            </div>
          </div>
          
          <div key={imageLoadKey} className="columns-2 sm:columns-3 md:columns-4 gap-3 [column-fill:_balance]">
            {extractedImages.map((url, index) => (
              <div
                key={`${url}-${imageLoadKey}`}
                className={`mb-3 break-inside-avoid rounded-lg border border-border hover:border-primary transition-all duration-200 overflow-hidden cursor-pointer group bg-muted/50 ${loadedImages.has(url) || index < 6 ? 'animate-fade-in' : 'opacity-0'}`}
                style={{ 
                  animationDelay: `${Math.min(index * 30, 200)}ms`,
                  opacity: loadedImages.has(url) || index < 6 ? undefined : 0
                }}
                onClick={() => openImage(index)}
              >
                <img
                  src={url}
                  alt={`Product ${index + 1}`}
                  className="w-full h-auto object-cover transition-transform duration-300 ease-out group-hover:scale-[1.02] group-hover:opacity-95"
                  loading="eager"
                  decoding="async"
                  onLoad={() => setLoadedImages(prev => new Set([...prev, url]))}
                />
              </div>
            ))}
          </div>

          {/* Progress indicator */}
          {pendingLinksRef.current.length > 0 && (
            <div className="text-xs text-center text-muted-foreground">
              Processed {processedLinksRef.current.size} of {pendingLinksRef.current.length} sources
            </div>
          )}
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
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-4 right-4 z-10 bg-background/80 hover:bg-background"
                onClick={closeImage}
              >
                <X className="w-5 h-5" />
              </Button>

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

              {selectedImageIndex > 0 && (
                <div
                  className="absolute left-4 top-1/2 -translate-y-1/2 z-10 cursor-pointer text-foreground/80 hover:text-foreground transition-colors"
                  onClick={goToPrevious}
                >
                  <ChevronLeft className="w-8 h-8" />
                </div>
              )}

              <div 
                className="w-full h-full flex items-center justify-center"
                onClick={closeImage}
              >
                <div 
                  ref={imageRef}
                  className="relative w-full h-full flex items-center justify-center touch-none select-none"
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
                      transition: (isDragging || touchStartRef.current) && !isTransitioning 
                        ? 'none' 
                        : 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
                      cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                      transformOrigin: 'center center',
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      touchAction: 'none',
                      willChange: 'transform'
                    }}
                    className="max-w-[80vw] max-h-[80vh] object-contain animate-scale-in"
                    draggable={false}
                  />
                </div>
              </div>

              {selectedImageIndex < extractedImages.length - 1 && (
                <div
                  className="absolute right-4 top-1/2 -translate-y-1/2 z-10 cursor-pointer text-foreground/80 hover:text-foreground transition-colors"
                  onClick={goToNext}
                >
                  <ChevronRight className="w-8 h-8" />
                </div>
              )}

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
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />
                
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="relative w-[85%] max-w-md aspect-[3/2] border-2 border-primary/60 rounded-lg">
                    <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-primary rounded-tl" />
                    <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-primary rounded-tr" />
                    <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-primary rounded-bl" />
                    <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-primary rounded-br" />
                  </div>
                </div>

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
                <div className="relative w-full h-full">
                  <img 
                    src={capturedImage} 
                    alt="Captured" 
                    className="w-full h-full object-contain"
                  />
                  
                  {isProcessingOCR && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <div className="bg-background/90 backdrop-blur-sm rounded-lg p-4 flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                        <span className="text-foreground">Extracting text...</span>
                      </div>
                    </div>
                  )}

                  {!isProcessingOCR && selectableTexts.length > 0 && (
                    <div className="absolute inset-0 p-4 overflow-auto pointer-events-none">
                      <div className="max-w-2xl mx-auto pointer-events-auto">
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
                
                {!isProcessingOCR && selectableTexts.length === 0 && (
                  <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
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

      {/* History Dialog */}
      <Dialog open={showHistoryDialog} onOpenChange={setShowHistoryDialog}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>Your recent product searches</DialogDescription>
          
          {searchHistory.length === 0 ? (
            <p className="text-muted-foreground text-center py-8">No search history yet</p>
          ) : (
            <div className="space-y-3">
              {searchHistory.map((item) => (
                <div key={item.id} className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent transition-colors">
                  <div className="flex-1">
                    <p className="font-medium">ID: {item.productId}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(item.timestamp).toLocaleString()}
                    </p>
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
                      <Search className="h-4 w-4" />
                    </Button>
                    {item.jiomartUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(item.jiomartUrl, '_blank')}
                      >
                        <ExternalLink className="h-4 w-4" />
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
        <History className="h-6 w-6" />
      </Button>
    </div>
  );
};
