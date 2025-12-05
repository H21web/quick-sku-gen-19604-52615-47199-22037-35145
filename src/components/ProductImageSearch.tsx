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

// ✅ Multiple API Keys
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
  thumbnail?: string;
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
  const imageRef = useRef<HTMLImageElement>(null);
  const touchStartRef = useRef<{ distance: number; zoom: number; x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastTapRef = useRef(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [extractedText, setExtractedText] = useState('');
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [selectableTexts, setSelectableTexts] = useState<Array<{ text: string; isNumber: boolean }>>([]);
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ✅ Progressive loading state
  const processedLinksRef = useRef<Set<string>>(new Set());
  const pendingLinksRef = useRef<string[]>([]);
  const currentSearchIdRef = useRef('');

  // ✅ API Key rotation state
  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map(key => ({ key, exhausted: false, lastReset: Date.now() }))
  );
  const currentKeyIndexRef = useRef(0);

  // Mobile detection
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

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

  // ✅ Get next available API key
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

  // ✅ FIXED: Save search to history - Merge duplicates and update timestamp
  const saveToHistory = useCallback((productId: string, jiomartUrl?: string, thumbnail?: string) => {
    setSearchHistory((prevHistory) => {
      // Check if product already exists in history
      const existingIndex = prevHistory.findIndex(item => item.productId === productId);
      
      if (existingIndex !== -1) {
        // Product exists - update timestamp and move to top
        const updatedItem = {
          ...prevHistory[existingIndex],
          timestamp: Date.now(),
          jiomartUrl: jiomartUrl || prevHistory[existingIndex].jiomartUrl,
          thumbnail: thumbnail || prevHistory[existingIndex].thumbnail
        };
        
        const updatedHistory = [
          updatedItem,
          ...prevHistory.filter((_, idx) => idx !== existingIndex)
        ].slice(0, 20);
        
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        return updatedHistory;
      } else {
        // New product - add to top
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

  // ✅ Progressive image extraction with faster batch processing
  const extractImagesProgressively = useCallback(async (
    links: string[],
    searchId: string
  ) => {
    if (searchId !== currentSearchIdRef.current) return;

    const batchSize = 6; // Increased from 4 to 6 for faster loading

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
                setTimeout(() => reject(new Error('timeout')), 4000) // Reduced from 6000ms to 4000ms
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

      // Update images immediately
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

      // Reduced delay between batches
      if (i + batchSize < links.length) {
        await new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 200ms to 100ms
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

  // ✅ MAIN SEARCH HANDLER
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

      // ✅ Parallel API calls
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

      // Update history with first image after extraction
      if (imageData.items?.length > 0) {
        setTimeout(() => {
          if (extractedImages.length > 0) {
            const updatedHistory = JSON.parse(localStorage.getItem('searchHistory') || '[]');
            if (updatedHistory[0]?.productId === idToSearch && !updatedHistory[0].thumbnail) {
              updatedHistory[0].thumbnail = extractedImages[0];
              localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
              setSearchHistory(updatedHistory);
            }
          }
        }, 2000);
      }

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

      // ✅ Start progressive extraction - Load first 8 images immediately
      const firstBatch = jiomartLinks.slice(0, 8); // Increased from 5 to 8
      const remainingLinks = jiomartLinks.slice(8);

      await extractImagesProgressively(firstBatch, newSearchId);

      // Continue with remaining in background
      if (remainingLinks.length > 0 && newSearchId === currentSearchIdRef.current) {
        setTimeout(() => {
          extractImagesProgressively(remainingLinks, newSearchId);
        }, 300); // Reduced from 500ms to 300ms
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
  }, [productId, saveToHistory, extractImagesProgressively, getNextApiKey, markApiKeyExhausted, fetchWithRetry, extractedImages]);

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

  // ✅ OPTIMIZED OCR: Faster processing with parallel operations
  const extractTextFromImage = async (imageData: string) => {
    setIsProcessingOCR(true);
    const startTime = performance.now();

    try {
      const img = new Image();
      img.src = imageData;
      await new Promise((resolve) => { img.onload = resolve; });

      const canvas = document.createElement('canvas');
      const maxDimension = 800; // Increased from 600 for better accuracy
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

      const compressedImage = canvas.toDataURL('image/jpeg', 0.7); // Increased quality from 0.6 to 0.7

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

      // ✅ Faster ID detection with optimized regex
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
        const separatedNumbers = fullText.match(/\d[\d\s\-_.]{4,}\d/g) || [];
        separatedNumbers.forEach(num => {
          const cleaned = num.replace(/\D/g, '');
          if (cleaned.length >= 6) foundIDs.add(cleaned);
        });
      }

      const uniqueIDs = Array.from(foundIDs).filter(id => id.length >= 6 && id.length <= 12);
      setDetectedIDs(uniqueIDs);
      setSelectableTexts(uniqueIDs.map(id => ({ text: id, isNumber: true })));

      const processingTime = ((performance.now() - startTime) / 1000).toFixed(3);

      if (uniqueIDs.length === 0) {
        toast.info('No product IDs detected');
      } else {
        toast.success(`Found ${uniqueIDs.length} ID(s) in ${processingTime}s`);
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

  // ✅ Aggressive image preloading for faster display
  useEffect(() => {
    if (extractedImages.length > 0) {
      extractedImages.slice(0, 10).forEach((url) => {
        const img = new Image();
        img.src = url;
      });
    }
  }, [extractedImages]);

  return (
    <div className="w-full max-w-6xl mx-auto p-4 space-y-6">
      {/* Search Section */}
      <div className="flex gap-2 items-center">
        <Input
          placeholder="Enter Product ID"
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1"
        />
        <Button variant="outline" size="icon" onClick={startCamera} title="Scan product">
          <Scan className="h-5 w-5" />
        </Button>
        <Button variant="outline" size="icon" onClick={() => setShowHistoryDialog(true)} title="Search history">
          <History className="h-5 w-5" />
        </Button>
        <Button onClick={() => handleSearch()} disabled={loading}>
          {loading ? 'Finding...' : 'Find'}
        </Button>
      </div>

      {/* Loading Skeletons */}
      {loading && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))}
        </div>
      )}

      {/* Extracted Images Grid */}
      {extractedImages.length > 0 && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold">
              Product Images ({extractedImages.length})
            </h2>
            {searchTime !== null && (
              <span className="text-sm text-muted-foreground">
                {searchTime.toFixed(2)}s
              </span>
            )}
            {(loading || isLoadingMore) && (
              <span className="text-sm text-muted-foreground animate-pulse">
                Loading...
              </span>
            )}
          </div>

          {/* Load More Button */}
          {pendingLinksRef.current.length > processedLinksRef.current.size && !loading && (
            <Button onClick={loadMoreImages} disabled={isLoadingMore} variant="outline" className="w-full">
              {isLoadingMore ? 'Loading...' : 'Load More'}
            </Button>
          )}

          {jiomartUrl && (
            <Button
              onClick={() => window.open(jiomartUrl, '_blank')}
              className="gap-2"
              variant="outline"
            >
              <ExternalLink className="h-4 w-4" />
              Open Product
            </Button>
          )}

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {extractedImages.map((url, index) => (
              <div
                key={`${imageLoadKey}-${url}-${index}`}
                className="relative aspect-square rounded-lg overflow-hidden border cursor-pointer hover:shadow-lg transition-shadow group"
                onClick={() => openImage(index)}
              >
                <img
                  src={url}
                  alt={`Product ${index + 1}`}
                  className="w-full h-full object-cover"
                  loading={index < 8 ? 'eager' : 'lazy'}
                  onLoad={() => setLoadedImages(prev => new Set([...prev, url]))}
                  onError={(e) => {
                    const target = e.currentTarget;
                    if (isMobile && !url.includes('/original/')) {
                      target.src = url.replace(/\/(small|medium|large)\//, '/original/');
                    }
                  }}
                />
              </div>
            ))}
          </div>

          {/* Progress indicator */}
          {pendingLinksRef.current.length > 0 && (
            <p className="text-sm text-muted-foreground text-center">
              Processed {processedLinksRef.current.size} of {pendingLinksRef.current.length} sources
            </p>
          )}
        </div>
      )}

      {/* Image Viewer Dialog */}
      <Dialog open={selectedImageIndex !== null} onOpenChange={(open) => !open && closeImage()}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] p-0">
          <DialogTitle className="sr-only">Product Image Viewer</DialogTitle>
          <DialogDescription className="sr-only">View and navigate product images</DialogDescription>

          {selectedImageIndex !== null && (
            <div className="relative w-full h-[90vh] flex items-center justify-center bg-black/95">
              {/* Zoom Controls */}
              <div className="absolute top-4 right-4 flex gap-2 z-50">
                <Button variant="secondary" size="icon" onClick={handleZoomOut} disabled={zoom <= 0.5}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button variant="secondary" size="icon" onClick={handleZoomIn} disabled={zoom >= 5}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </div>

              {/* Previous Button */}
              {selectedImageIndex > 0 && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute left-4 z-50"
                  onClick={goToPrevious}
                >
                  <ChevronLeft className="h-6 w-6" />
                </Button>
              )}

              {/* Image */}
              <div
                className="relative w-full h-full flex items-center justify-center overflow-hidden"
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
                  ref={imageRef}
                  src={extractedImages[selectedImageIndex]}
                  alt={`Product ${selectedImageIndex + 1}`}
                  style={{
                    transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                    transition: isTransitioning ? 'opacity 0.2s' : 'none',
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

              {/* Next Button */}
              {selectedImageIndex < extractedImages.length - 1 && (
                <Button
                  variant="secondary"
                  size="icon"
                  className="absolute right-4 z-50"
                  onClick={goToNext}
                >
                  <ChevronRight className="h-6 w-6" />
                </Button>
              )}

              {/* Image Counter */}
              <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full text-sm z-50">
                {selectedImageIndex + 1} / {extractedImages.length}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Camera Dialog */}
      <Dialog open={showCameraDialog} onOpenChange={(open) => !open && stopCamera()}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>Camera Scanner</DialogTitle>
          <DialogDescription>Capture product image for text extraction</DialogDescription>

          {!capturedImage ? (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full rounded-lg bg-black"
              />
              <canvas ref={canvasRef} className="hidden" />
              <p className="text-sm text-muted-foreground text-center">
                Position product text within the frame
              </p>
              <Button onClick={captureImage} className="w-full gap-2" size="lg">
                <Scan className="h-5 w-5" />
                Capture
              </Button>
            </>
          ) : (
            <>
              <img src={capturedImage} alt="Captured" className="w-full rounded-lg" />
              <canvas ref={canvasRef} className="hidden" />

              {isProcessingOCR && (
                <div className="text-center py-4">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
                  <p className="text-sm text-muted-foreground">Extracting text...</p>
                </div>
              )}

              {!isProcessingOCR && detectedIDs.length > 0 && (
                <div className="space-y-3">
                  <h3 className="font-semibold text-center">Detected Product IDs</h3>
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {detectedIDs.map((id, index) => (
                      <button
                        key={index}
                        onClick={() => useDetectedID(id)}
                        className="w-full bg-primary/95 hover:bg-primary text-primary-foreground rounded-lg px-4 py-3 text-base font-mono font-bold shadow-lg transition-all hover:scale-[1.02] active:scale-95 flex items-center justify-between"
                      >
                        <span>{id}</span>
                        <Search className="h-5 w-5" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {!isProcessingOCR && detectedIDs.length === 0 && (
                <Button onClick={retakePhoto} variant="outline" className="w-full gap-2">
                  <RefreshCw className="h-4 w-4" />
                  Retake Photo
                </Button>
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
            <p className="text-center text-muted-foreground py-8">No search history yet</p>
          ) : (
            <div className="space-y-3">
              {searchHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 p-3 border rounded-lg hover:bg-accent cursor-pointer transition-colors"
                >
                  {item.thumbnail && (
                    <img
                      src={item.thumbnail}
                      alt={item.productId}
                      className="w-16 h-16 object-cover rounded"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-mono font-semibold">ID: {item.productId}</p>
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

          {searchHistory.length > 0 && (
            <div className="pt-4 border-t">
              <Button
                variant="destructive"
                onClick={() => {
                  setSearchHistory([]);
                  localStorage.removeItem('searchHistory');
                  toast.success('History cleared');
                }}
                className="w-full"
              >
                <X className="h-4 w-4 mr-2" />
                Clear All History
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
