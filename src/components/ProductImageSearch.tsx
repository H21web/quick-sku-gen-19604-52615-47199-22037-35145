import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
} from 'react';

import { Input } from './ui/input';
import { Button } from './ui/button';
import {
  Search,
  X,
  Scan,
  ExternalLink,
  History,
  Camera,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { toast } from 'sonner';
import {
  extractAllProductImages,
  preloadImages,
} from '@/lib/imageExtractor';
import { GOOGLE_SEARCH_ENGINE_ID } from '@/lib/config';
import { Skeleton } from './ui/skeleton';

const OCR_SPACE_API_KEY = 'K86120042088957';

const GOOGLE_API_KEYS = [
  'AIzaSyCUb-RrSjsScT_gfhmdyOMVp3ZHSSsai1U',
  'AIzaSyDVvxwYZzZAOLy5Cd3FMNrQKcxZxldsJCY',
  'AIzaSyBdRbGEG_nLOhaI1_RpNTN6kiwhEVcuxXo',
  'AIzaSyDsTLL2TqDbV2DhXEwxny_5VIb1IjmQVn0',
  'AIzaSyC0RGsJ8Q0Ery9CjyLBEp25REWV_SqpQPE',
  'AIzaSyB5tGVlcRpnrRkfrttWo4kMK1-9PGj15y4',
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

export const ProductImageSearch = () => {
  const [productId, setProductId] = useState('');
  const [extractedImages, setExtractedImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(
    null
  );
  const [showCameraDialog, setShowCameraDialog] = useState(false);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [isProcessingOCR, setIsProcessingOCR] = useState(false);
  const [detectedIDs, setDetectedIDs] = useState<string[]>([]);
  const [jiomartUrl, setJiomartUrl] = useState('');
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [isAutoLoading, setIsAutoLoading] = useState(false);
  const [showScanAnimation, setShowScanAnimation] = useState(false);

  // progressive loading progress
  const [totalLinks, setTotalLinks] = useState(0);
  const [processedLinksCount, setProcessedLinksCount] = useState(0);

  // Pan/Zoom states
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const touchStartRef = useRef<{
    distance: number;
    zoom: number;
    x: number;
    y: number;
  } | null>(null);
  const swipeStartRef = useRef<{
    x: number;
    y: number;
    time: number;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentSearchIdRef = useRef('');
  const processedLinksRef = useRef<Set<string>>(new Set());

  const [apiKeyStatuses, setApiKeyStatuses] = useState<ApiKeyStatus[]>(() =>
    GOOGLE_API_KEYS.map((key) => ({
      key,
      exhausted: false,
      lastReset: Date.now(),
    }))
  );
  const currentKeyIndexRef = useRef(0);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // load history + API key reset
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
      setApiKeyStatuses((prev) =>
        prev.map((status) => ({
          ...status,
          exhausted: false,
          lastReset: Date.now(),
        }))
      );
    }, 3600000);

    return () => clearInterval(resetInterval);
  }, []);

  const getNextApiKey = useCallback((): string | null => {
    const availableKeys = apiKeyStatuses.filter((k) => !k.exhausted);
    if (availableKeys.length === 0) return null;
    const key =
      availableKeys[currentKeyIndexRef.current % availableKeys.length];
    currentKeyIndexRef.current++;
    return key.key;
  }, [apiKeyStatuses]);

  const markApiKeyExhausted = useCallback((apiKey: string) => {
    setApiKeyStatuses((prev) =>
      prev.map((status) =>
        status.key === apiKey ? { ...status, exhausted: true } : status
      )
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
      if (!apiKey) throw new Error('All API keys exhausted. Please try again later.');

      try {
        const url = buildUrl(apiKey);
        const response = await fetch(url);

        if (response.ok) return response;

        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || '';
        const isRateLimitError =
          response.status === 429 ||
          errorMessage.toLowerCase().includes('quota') ||
          errorMessage.toLowerCase().includes('limit') ||
          errorMessage.toLowerCase().includes('ratelimitexceeded') ||
          errorData.error?.code === 429;

        if (isRateLimitError) {
          console.warn('API key exhausted, rotating to next key...');
          markApiKeyExhausted(apiKey);
          attempts++;
          continue;
        }

        throw new Error(
          errorMessage || `API request failed with status ${response.status}`
        );
      } catch (error: any) {
        lastError = error;
        if (
          error.message.includes('fetch') ||
          error.message.includes('network')
        ) {
          attempts++;
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error('All API keys failed');
  };

  const saveToHistory = useCallback(
    (productId: string, jiomartUrl?: string, thumbnail?: string) => {
      setSearchHistory((prevHistory) => {
        const existingIndex = prevHistory.findIndex(
          (item) => item.productId === productId
        );

        if (existingIndex !== -1) {
          const updatedItem: SearchHistoryItem = {
            ...prevHistory[existingIndex],
            timestamp: Date.now(),
            jiomartUrl:
              jiomartUrl || prevHistory[existingIndex].jiomartUrl,
            thumbnail:
              thumbnail || prevHistory[existingIndex].thumbnail,
          };

          const updatedHistory = [
            updatedItem,
            ...prevHistory.filter((_, idx) => idx !== existingIndex),
          ].slice(0, 20);

          localStorage.setItem(
            'searchHistory',
            JSON.stringify(updatedHistory)
          );
          return updatedHistory;
        } else {
          const newHistoryItem: SearchHistoryItem = {
            id: Date.now().toString(),
            productId,
            timestamp: Date.now(),
            jiomartUrl,
            thumbnail,
          };

          const updatedHistory = [newHistoryItem, ...prevHistory].slice(
            0,
            20
          );
          localStorage.setItem(
            'searchHistory',
            JSON.stringify(updatedHistory)
          );
          return updatedHistory;
        }
      });
    },
    []
  );

  // load all Jiomart product image pages in batches with progress
  const loadAllImagesSimultaneously = useCallback(
    async (links: string[], searchId: string) => {
      setIsAutoLoading(true);
      setTotalLinks(links.length);
      setProcessedLinksCount(0);

      const batchSize = 4;
      const batches: string[][] = [];
      for (let i = 0; i < links.length; i += batchSize) {
        batches.push(links.slice(i, i + batchSize));
      }

      for (const batch of batches) {
        if (searchId !== currentSearchIdRef.current) break;

        const batchResults = await Promise.allSettled(
          batch.map(async (link) => {
            if (processedLinksRef.current.has(link)) {
              setProcessedLinksCount((c) => c + 1);
              return [] as string[];
            }

            try {
              const images = await Promise.race<string[] | unknown>([
                extractAllProductImages(link),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error('timeout')),
                    3000
                  )
                ),
              ]);

              processedLinksRef.current.add(link);
              setProcessedLinksCount((c) => c + 1);
              return Array.isArray(images) ? images : [];
            } catch {
              processedLinksRef.current.add(link);
              setProcessedLinksCount((c) => c + 1);
              return [] as string[];
            }
          })
        );

        const newImages = batchResults
          .filter((r): r is PromiseFulfilledResult<string[]> => r.status === 'fulfilled')
          .flatMap((r) => r.value);

        if (newImages.length > 0 && searchId === currentSearchIdRef.current) {
          setExtractedImages((prev) => {
            const combined = [...prev, ...newImages];
            const unique = Array.from(new Set(combined));
            return [
              ...unique.filter((url) => url.includes('/original/')),
              ...unique.filter((url) => !url.includes('/original/')),
            ];
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      setIsAutoLoading(false);
    },
    []
  );

  const handleSearch = useCallback(
    async (searchIdParam?: string) => {
      const idToSearch = searchIdParam || productId;
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
      setTotalLinks(0);
      setProcessedLinksCount(0);

      try {
        const query = `site:jiomart.com ${idToSearch}`;

        const [imageResponse, webResponse] = await Promise.all([
          fetchWithRetry((apiKey) =>
            `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(
              query
            )}&searchType=image&num=10&fields=items(link)`
          ),
          fetchWithRetry((apiKey) =>
            `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(
              query
            )}&num=1&fields=items(link)`
          ),
        ]);

        const [imageData, webData] = await Promise.all([
          imageResponse.json(),
          webResponse.json(),
        ]);

        let foundUrl = '';
        if (webData.items?.[0]?.link?.includes('jiomart.com')) {
          foundUrl = webData.items[0].link;
          setJiomartUrl(foundUrl);
          saveToHistory(idToSearch, foundUrl);
        }

        if (!imageData.items?.length) {
          toast.error('No images found');
          return;
        }

        const jiomartLinks = Array.from(
          new Set(
            imageData.items
              .map((item: any) => item.link)
              .filter((url: string) =>
                url.includes('jiomart.com/images/product')
              )
          )
        ) as string[];

        if (!jiomartLinks.length) {
          toast.error('No product images found');
          return;
        }

        // load ALL links at once (progressive)
        setExtractedImages([]);
        await loadAllImagesSimultaneously(jiomartLinks, newSearchId);

        // if at least one image loaded, use as history thumbnail
        if (extractedImages.length > 0 && foundUrl) {
          saveToHistory(idToSearch, foundUrl, extractedImages[0]);
        }
      } catch (error: any) {
        console.error('Search error:', error);
        if (error.message?.includes('exhausted')) {
          toast.error(
            'All API keys exhausted. Please try again in an hour.'
          );
        } else {
          toast.error(error.message || 'Search failed. Try again.');
        }
      } finally {
        setLoading(false);
      }
    },
    [productId, saveToHistory, fetchWithRetry, loadAllImagesSimultaneously, extractedImages]
  );

  // camera + OCR
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
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
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
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
      cameraStream.getTracks().forEach((track) => track.stop());
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
      await new Promise((resolve) => {
        img.onload = resolve;
      });

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
      }

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

      if (!response.ok) {
        throw new Error('OCR failed');
      }

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
        /ID\s*[:：.,-]?\s*(\d{5,})/gi,
        /[1I]D\s*[:：.,-]?\s*(\d{5,})/gi,
        /Product\s*[:：.,-]?\s*(\d{5,})/gi,
        /Item\s*[:：.,-]?\s*(\d{5,})/gi,
        /Code\s*[:：.,-]?\s*(\d{5,})/gi,
      ];

      for (const pattern of idPatterns) {
        const matches = [
          ...fullText.matchAll(pattern),
          ...cleanedText.matchAll(pattern),
        ];
        matches.forEach((m) => {
          if (m[1]) {
            foundIDs.add(m[1].replace(/\D/g, ''));
          }
        });
      }

      if (foundIDs.size === 0) {
        const numberMatches = [...fullText.matchAll(/\b(\d{6,12})\b/g)];
        numberMatches.forEach((m) => m[1] && foundIDs.add(m[1]));
      }

      if (foundIDs.size === 0) {
        const separatedNumbers =
          fullText.match(/\d[\d\s\-_.]{4,}\d/g) || [];
        separatedNumbers.forEach((num) => {
          const cleaned = num.replace(/\D/g, '');
          if (cleaned.length >= 6) foundIDs.add(cleaned);
        });
      }

      const uniqueIDs = Array.from(foundIDs).filter(
        (id) => id.length >= 6 && id.length <= 12
      );
      setDetectedIDs(uniqueIDs);

      if (uniqueIDs.length === 0) {
        toast.info('No product IDs detected');
      } else {
        const firstID = uniqueIDs[0];
        setProductId(firstID);
        stopCamera();
        toast.success(
          `Found ${uniqueIDs.length} ID(s). Searching: ${firstID}`
        );
        setTimeout(() => handleSearch(firstID), 100);
      }
    } catch (error) {
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

  // pan/zoom handlers
  const getTouchDistance = (touch1: Touch, touch2: Touch) => {
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      touchStartRef.current = {
        distance,
        zoom,
        x: position.x,
        y: position.y,
      };
    } else if (e.touches.length === 1) {
      swipeStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
        time: Date.now(),
      };
      if (zoom > 1) {
        setIsDragging(true);
        setDragStart({
          x: e.touches[0].clientX - position.x,
          y: e.touches[0].clientY - position.y,
        });
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchStartRef.current) {
      e.preventDefault();
      const distance = getTouchDistance(e.touches[0], e.touches[1]);
      const scale = distance / touchStartRef.current.distance;
      const newZoom = Math.min(
        Math.max(touchStartRef.current.zoom * scale, 1),
        5
      );
      setZoom(newZoom);
    } else if (e.touches.length === 1 && zoom > 1 && isDragging) {
      e.preventDefault();
      const newX = e.touches[0].clientX - dragStart.x;
      const newY = e.touches[0].clientY - dragStart.y;
      setPosition({ x: newX, y: newY });
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (
      swipeStartRef.current &&
      zoom === 1 &&
      e.changedTouches.length === 1
    ) {
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - swipeStartRef.current.x;
      const deltaY = touch.clientY - swipeStartRef.current.y;
      const deltaTime = Date.now() - swipeStartRef.current.time;

      if (
        Math.abs(deltaX) > Math.abs(deltaY) &&
        Math.abs(deltaX) > 50 &&
        deltaTime < 300
      ) {
        if (
          deltaX > 0 &&
          selectedImageIndex !== null &&
          selectedImageIndex > 0
        ) {
          setSelectedImageIndex(selectedImageIndex - 1);
          setZoom(1);
          setPosition({ x: 0, y: 0 });
        } else if (
          deltaX < 0 &&
          selectedImageIndex !== null &&
          selectedImageIndex < extractedImages.length - 1
        ) {
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
      setDragStart({
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      });
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

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((prev) => Math.min(Math.max(prev + delta, 1), 5));
  };

  const goToPrevious = () => {
    if (selectedImageIndex !== null && selectedImageIndex > 0) {
      setSelectedImageIndex(selectedImageIndex - 1);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  const goToNext = () => {
    if (
      selectedImageIndex !== null &&
      selectedImageIndex < extractedImages.length - 1
    ) {
      setSelectedImageIndex(selectedImageIndex + 1);
      setZoom(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  useEffect(() => {
    if (zoom === 1) {
      setPosition({ x: 0, y: 0 });
    }
  }, [zoom]);

  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cameraStream]);

  useEffect(() => {
    if (extractedImages.length > 0) {
      preloadImages(extractedImages, 15);
    }
  }, [extractedImages]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex w-full md:w-auto items-center gap-2">
          <div className="relative w-full">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={productId}
              onChange={(e) =>
                setProductId(e.target.value.replace(/\D/g, ''))
              }
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Enter or scan product ID"
              className="h-11 pr-11 font-mono"
            />
            {productId && (
              <button
                type="button"
                onClick={() => setProductId('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            )}
          </div>

          <Button
            onClick={() => handleSearch()}
            disabled={loading}
            className="h-11 px-6"
          >
            {loading ? (
              <>
                <Search className="mr-2 h-4 w-4 animate-spin" />
                Searching…
              </>
            ) : (
              <>
                <Search className="mr-2 h-4 w-4" />
                Find
              </>
            )}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {extractedImages.length > 0 && (
            <>
              <span className="text-sm text-muted-foreground">
                {extractedImages.length} image
                {extractedImages.length !== 1 ? 's' : ''}
              </span>
              {isAutoLoading && totalLinks > 0 && (
                <span className="text-xs text-muted-foreground">
                  Loading {processedLinksCount}/{totalLinks} sources…
                </span>
              )}
            </>
          )}

          {jiomartUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(jiomartUrl, '_blank')}
              className="h-8"
            >
              <ExternalLink className="mr-2 h-3 w-3" />
              Open Product
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistoryDialog(true)}
            className="h-8"
          >
            <History className="mr-2 h-3 w-3" />
            History
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={startCamera}
            className="h-8"
          >
            <Camera className="mr-2 h-3 w-3" />
            Scan
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="min-h-[200px]">
        {loading && (
          <div className="flex flex-col gap-2">
            <div className="text-sm text-muted-foreground">
              Searching product…
              {totalLinks > 0
                ? ` ${Math.round(
                    (processedLinksCount / Math.max(totalLinks, 1)) * 100
                  )}%`
                : ''}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[...Array(8)].map((_, i) => (
                <Skeleton
                  key={i}
                  className="aspect-[3/4] w-full rounded-md"
                />
              ))}
            </div>
          </div>
        )}

        {!loading && extractedImages.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {extractedImages.map((url, index) => (
              <button
                key={`${url}-${index}`}
                type="button"
                className="relative group"
                onClick={() => {
                  setSelectedImageIndex(index);
                  setZoom(1);
                  setPosition({ x: 0, y: 0 });
                }}
              >
                <img
                  src={url}
                  alt={`Product ${index + 1}`}
                  className="aspect-[3/4] w-full rounded-md object-cover border bg-muted"
                  loading="lazy"
                />
                <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  {index + 1}
                </span>
              </button>
            ))}
          </div>
        )}

        {!loading && extractedImages.length === 0 && (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            Enter an ID or scan to begin.
          </div>
        )}
      </div>

      {/* Fullscreen viewer */}
      {selectedImageIndex !== null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/90">
          <div className="relative h-full w-full">
            <img
              src={extractedImages[selectedImageIndex]}
              alt="Product fullscreen"
              className="absolute left-1/2 top-1/2 max-h-[90%] max-w-[90%] -translate-x-1/2 -translate-y-1/2 select-none"
              style={{
                cursor:
                  zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
                transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${zoom})`,
                transition: isDragging
                  ? 'none'
                  : 'transform 0.2s ease-out',
                touchAction: 'none',
              }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onWheel={handleWheel}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              draggable={false}
            />

            {/* Close */}
            <button
              type="button"
              onClick={() => {
                setSelectedImageIndex(null);
                setZoom(1);
                setPosition({ x: 0, y: 0 });
              }}
              className="absolute right-4 top-4 z-10 rounded-full bg-black/40 p-3 text-white hover:bg-black/60"
            >
              <X />
            </button>

            {/* arrows desktop */}
            {!isMobile && selectedImageIndex > 0 && (
              <button
                type="button"
                onClick={goToPrevious}
                className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white hover:bg-black/60"
              >
                <ChevronLeft />
              </button>
            )}
            {!isMobile &&
              selectedImageIndex < extractedImages.length - 1 && (
                <button
                  type="button"
                  onClick={goToNext}
                  className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 p-3 text-white hover:bg-black/60"
                >
                  <ChevronRight />
                </button>
              )}

            {/* counter + zoom */}
            <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
              {selectedImageIndex + 1} / {extractedImages.length}
              {zoom > 1 && (
                <span className="ml-2">
                  {(zoom * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* OCR dialog */}
      <Dialog
        open={showCameraDialog}
        onOpenChange={(open) => {
          if (!open) stopCamera();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>Scan Product</DialogTitle>
          <DialogDescription>
            Capture and extract product ID
          </DialogDescription>

          <div className="relative mt-2 aspect-[3/4] w-full overflow-hidden rounded-lg bg-black">
            {!capturedImage ? (
              <video
                ref={videoRef}
                className="h-full w-full object-cover"
                autoPlay
                playsInline
              />
            ) : (
              <img
                src={capturedImage}
                alt="Captured"
                className="h-full w-full object-cover"
              />
            )}

            <canvas ref={canvasRef} className="hidden" />

            {showScanAnimation && (
              <div className="pointer-events-none absolute inset-0">
                <div className="absolute inset-x-4 top-1/2 h-0.5 bg-gradient-to-r from-transparent via-green-400 to-transparent animate-pulse" />
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {!capturedImage ? (
              <Button onClick={captureImage}>
                <Scan className="mr-2 h-4 w-4" />
                Capture
              </Button>
            ) : isProcessingOCR ? (
              <Button disabled>
                <Scan className="mr-2 h-4 w-4 animate-spin" />
                Extracting text…
              </Button>
            ) : detectedIDs.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">
                  Detected Product IDs
                </div>
                {detectedIDs.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => useDetectedID(id)}
                    className="w-full rounded-lg bg-primary px-4 py-3 font-mono font-bold text-primary-foreground transition-all hover:bg-primary/90 active:scale-95"
                  >
                    {id}
                  </button>
                ))}
                <Button variant="outline" onClick={retakePhoto}>
                  Retake Photo
                </Button>
              </div>
            ) : (
              <Button variant="outline" onClick={retakePhoto}>
                Retake Photo
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* history dialog */}
      <Dialog
        open={showHistoryDialog}
        onOpenChange={setShowHistoryDialog}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>Search History</DialogTitle>
          <DialogDescription>
            Your recent product searches
          </DialogDescription>

          {searchHistory.length === 0 ? (
            <div className="mt-4 text-sm text-muted-foreground">
              No search history yet
            </div>
          ) : (
            <div className="mt-3 flex max-h-80 flex-col gap-2 overflow-y-auto">
              {searchHistory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <div className="flex items-center gap-3">
                    {item.thumbnail && (
                      <img
                        src={item.thumbnail}
                        alt={item.productId}
                        className="h-10 w-10 rounded object-cover"
                      />
                    )}
                    <div>
                      <div className="font-mono text-sm">
                        {item.productId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(
                          item.timestamp
                        ).toLocaleString()}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-8 w-8"
                      onClick={() => {
                        setProductId(item.productId);
                        setShowHistoryDialog(false);
                        handleSearch(item.productId);
                      }}
                    >
                      <Search className="h-3 w-3" />
                    </Button>
                    {item.jiomartUrl && (
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                        onClick={() =>
                          window.open(
                            item.jiomartUrl,
                            '_blank'
                          )
                        }
                      >
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {searchHistory.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                setSearchHistory([]);
                localStorage.removeItem('searchHistory');
                toast.success('History cleared');
              }}
            >
              Clear All History
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
