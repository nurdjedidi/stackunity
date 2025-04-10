import axios from 'axios';
import { load as cheerioLoad } from 'cheerio';
import { createError, defineEventHandler, H3Event, readBody } from 'h3';
import { performance } from 'perf_hooks';
import type { CheerioSelector, ExtendedResponse, SiteAnalysisResult, StructuredData, WebsiteAnalysisResult } from './analyzer-types';

export default defineEventHandler(async (event: H3Event): Promise<SiteAnalysisResult> => {
  try {
    const body = await readBody(event);
    const { url, maxPages = 50, focusOnContact = false, checkSitemap = true, checkRobotsTxt = true } = body;

    if (!url) {
      throw createError({
        statusCode: 400,
        message: 'URL requise'
      });
    }

    console.log(`Démarrage de l'analyse pour: ${url}, options:`, JSON.stringify({
      maxPages,
      focusOnContact,
      checkSitemap,
      checkRobotsTxt
    }, null, 2));

    try {
      new URL(url);
    } catch (urlError) {
      throw createError({
        statusCode: 400,
        message: 'URL invalide'
      });
    }

    let urls: string[] = [];
    try {
      urls = await crawlWebsite(url, maxPages);
      console.log(`Analyse de ${urls.length} pages...`);
    } catch (crawlError) {
      console.error('Erreur lors du crawl:', crawlError);
      urls = [url];
    }

    let prioritizedUrls = [...urls];
    if (focusOnContact) {
      const contactKeywords = ['contact', 'about', 'nous', 'about-us', 'a-propos'];
      prioritizedUrls = urls.sort((a, b) => {
        try {
          const aIsContact = contactKeywords.some(keyword => a.toLowerCase().includes(keyword));
          const bIsContact = contactKeywords.some(keyword => b.toLowerCase().includes(keyword));
          if (aIsContact && !bIsContact) return -1;
          if (!aIsContact && bIsContact) return 1;
          return 0;
        } catch (e) {
          console.error('Erreur lors du tri des URLs:', e);
          return 0;
        }
      });

      prioritizedUrls = prioritizedUrls.slice(0, Math.min(5, prioritizedUrls.length));
    }

    const results: Record<string, WebsiteAnalysisResult> = {};
    let totalLoadTime = 0;
    let totalWarnings = 0;
    let missingTitles = 0;
    let missingDescriptions = 0;
    let missingAltTags = 0;
    let totalFCP = 0;
    let totalLCP = 0;
    let totalTTFB = 0;
    let pagesWithStructuredData = 0;
    let pagesWithSocialTags = 0;
    let mobileCompatiblePages = 0;
    let securePages = 0;

    const pagesToAnalyze = prioritizedUrls.slice(0, Math.min(5, prioritizedUrls.length));

    for (const pageUrl of pagesToAnalyze) {
      try {
        console.log(`Analyse de la page: ${pageUrl}`);
        const result = await analyzeWebsite(pageUrl);
        results[pageUrl] = result;

        totalLoadTime += result.performance.loadTime;
        totalWarnings += result.issues.length;
        if (!result.seo.title) missingTitles++;
        if (!result.seo.description) missingDescriptions++;
        missingAltTags += result.seo.images.withoutAlt;
        totalFCP += result.performance.fcp;
        totalLCP += result.performance.lcp;
        totalTTFB += result.performance.ttfb;
        if (result.seo.structuredData.count > 0) pagesWithStructuredData++;
        if (Object.keys(result.seo.meta.og).length > 0 || Object.keys(result.seo.meta.twitter).length > 0) {
          pagesWithSocialTags++;
        }
        if (result.technical.mobile.viewport) mobileCompatiblePages++;
        if (result.technical.https) securePages++;
      } catch (pageError) {
        console.error(`Erreur lors de l'analyse de ${pageUrl}:`, pageError);
      }
    }

    if (Object.keys(results).length === 0) {
      console.log('Aucun résultat d\'analyse disponible, création d\'un résultat de secours');
      try {
        const fallbackResult = await createFallbackResult(url);
        results[url] = fallbackResult;
      } catch (fallbackError) {
        console.error('Erreur lors de la création du résultat de secours:', fallbackError);
        throw createError({
          statusCode: 500,
          message: 'Impossible d\'analyser le site'
        });
      }
    }

    const pageCount = Object.keys(results).length || 1;

    let extractedContactInfo: Record<string, string> = {};
    try {
      if (focusOnContact) {
        for (const pageUrl of Object.keys(results).slice(0, 2)) {
          try {
            const contactInfo = await findContactInfo(url, Object.keys(results));
            if (Object.keys(contactInfo).length > 0) {
              extractedContactInfo = contactInfo;
              break;
            }
          } catch (contactError) {
            console.error(`Erreur lors de l'extraction des informations de contact de ${pageUrl}:`, contactError);
          }
        }
      }
    } catch (contactError) {
      console.error('Erreur lors de l\'extraction des informations de contact:', contactError);
    }

    const imagesData: Record<string, any> = {};
    for (const [url, result] of Object.entries(results)) {
      if (result && result.seo && result.seo.images) {
        console.log(`Extraction des images pour ${url}:`, JSON.stringify(result.seo.images, null, 2));
        imagesData[url] = {
          images: result.seo.images
        };
      }
    }

    const sitemap = checkSitemap ? generateSitemap(urls, imagesData) : '';

    return {
      urlMap: { [url]: urls },
      visitedURLs: urls,
      seoResults: results,
      summary: {
        totalPages: pageCount,
        averageLoadTime: totalLoadTime / pageCount,
        totalWarnings,
        missingTitles,
        missingDescriptions,
        missingAltTags,
        averageFCP: totalFCP / pageCount,
        averageLCP: totalLCP / pageCount,
        averageTTFB: totalTTFB / pageCount,
        pagesWithStructuredData,
        pagesWithSocialTags,
        mobileCompatiblePages,
        securePages
      },
      generatedSitemap: sitemap,
      rankedUrls: rankPages(results),
      schemaOrg: {
        contactInfo: extractedContactInfo
      }
    };
  } catch (error) {
    console.error('Erreur lors de l\'analyse:', error);
    throw createError({
      statusCode: 500,
      message: `Erreur lors de l'analyse du site: ${error.message || 'Erreur inconnue'}`
    });
  }
});

async function analyzeWebsite(url: string): Promise<WebsiteAnalysisResult> {
  const startTime = performance.now();
  const response = await axios.get(url);
  const loadTime = performance.now() - startTime;
  const html = response.data;
  const $ = cheerioLoad(html);

  const performanceData = {
    ttfb: loadTime * 0.2,
    fcp: loadTime * 0.4,
    lcp: loadTime * 0.6,
    cls: 0.1,
    speedIndex: loadTime * 0.5,
    totalBlockingTime: loadTime * 0.3,
    loadTime,
    resourceLoadTimes: {
      total: loadTime,
      html: loadTime * 0.1,
      css: loadTime * 0.2,
      js: loadTime * 0.3,
      images: loadTime * 0.2,
      other: loadTime * 0.2
    },
    resourceSizes: {
      total: response.data.length,
      html: response.data.length,
      css: 0,
      js: 0,
      images: 0,
      other: 0
    }
  };

  const imagesData = analyzeImages($);
  const linksData = analyzeLinks($, url);
  const accessibilityData = analyzeAccessibility($);

  const seoData = {
    title: $('title').text().trim(),
    description: $('meta[name="description"]').attr('content') || '',
    headings: {
      h1: $('h1').map((_, el) => $(el).text().trim()).get() as string[],
      h2: $('h2').map((_, el) => $(el).text().trim()).get() as string[],
      h3: $('h3').map((_, el) => $(el).text().trim()).get() as string[],
      h4: $('h4').map((_, el) => $(el).text().trim()).get() as string[],
      h5: $('h5').map((_, el) => $(el).text().trim()).get() as string[],
      h6: $('h6').map((_, el) => $(el).text().trim()).get() as string[]
    },
    images: imagesData,
    links: {
      internal: linksData.internal,
      external: linksData.external,
      broken: [] as string[],
      nofollow: [] as string[]
    },
    meta: {
      viewport: $('meta[name="viewport"]').attr('content') || false,
      robots: $('meta[name="robots"]').attr('content'),
      canonical: $('link[rel="canonical"]').attr('href'),
      og: {} as Record<string, string>,
      twitter: {} as Record<string, string>
    },
    wordCount: $('body').text().trim().split(/\s+/).length,
    readabilityScore: calculateReadabilityScore($('body').text()),
    keywordDensity: calculateKeywordDensity($('body').text()),
    structuredData: {
      data: [] as StructuredData[],
      count: 0,
      types: {} as Record<string, number>
    }
  };

  $('meta').each((_, el) => {
    const $meta = $(el);
    const property = $meta.attr('property');
    const name = $meta.attr('name');
    const content = $meta.attr('content');

    if (property?.startsWith('og:') && content) {
      seoData.meta.og[property.replace('og:', '')] = content;
    } else if (name?.startsWith('twitter:') && content) {
      seoData.meta.twitter[name.replace('twitter:', '')] = content;
    }
  });

  $('a[rel*="nofollow"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      seoData.links.nofollow.push(href);
    }
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const content = $(el).html() || '{}';
      const data = JSON.parse(content);
      if (data && typeof data === 'object' && '@type' in data) {
        const structuredData = data as StructuredData;
        (seoData.structuredData.data as StructuredData[]).push(structuredData);
        seoData.structuredData.count++;
        const type = structuredData['@type'];
        if (Array.isArray(type)) {
          type.forEach(t => {
            seoData.structuredData.types[t] = (seoData.structuredData.types[t] || 0) + 1;
          });
        } else {
          seoData.structuredData.types[type] = (seoData.structuredData.types[type] || 0) + 1;
        }
      }
    } catch (e) {
      console.error('Erreur parsing JSON-LD:', e);
    }
  });

  const technicalData = {
    statusCode: response.status,
    https: url.startsWith('https'),
    mobile: {
      viewport: $('meta[name="viewport"]').length > 0,
      responsive: checkResponsiveness($)
    },
    security: {
      headers: response.headers as Record<string, string>,
      securityIssues: []
    },
    meta: {
      charset: $('meta[charset]').attr('charset'),
      language: $('html').attr('lang'),
      viewport: $('meta[name="viewport"]').attr('content'),
      themeColor: $('meta[name="theme-color"]').attr('content')
    },
    response: {
      headers: response.headers as Record<string, string>,
      size: html.length,
      time: 0
    }
  };

  const urlObj = new URL(url);
  const isRootUrl = urlObj.pathname === '/' || urlObj.pathname === '';
  let technicalSEO: WebsiteAnalysisResult['technicalSEO'] | undefined = undefined;

  if (isRootUrl) {
    const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;

    const sitemapStatus = await checkSitemap(baseUrl);

    const robotsTxtStatus = await checkRobotsTxt(baseUrl);

    technicalSEO = {
      sitemapFound: sitemapStatus.found,
      sitemapUrl: sitemapStatus.url,
      sitemapUrls: sitemapStatus.urls,
      robotsTxtFound: robotsTxtStatus.found,
      robotsTxtContent: robotsTxtStatus.content,
      schemaTypeCount: seoData.structuredData.types
    };
  }

  const issues = generateSEOIssues(seoData, performanceData);

  let contactInfo: Record<string, string> = {};
  try {
    contactInfo = await findContactInfo(url, linksData.internal.map(link => link.href));
    console.log('Informations de contact trouvées:', contactInfo);
  } catch (error) {
    console.error('Erreur lors de la recherche des informations de contact:', error);
  }

  const schemaData = analyzeSchemaOrg(url, html, $, seoData as any, contactInfo);

  const result: ExtendedWebsiteAnalysisResult = {
    url,
    performance: performanceData,
    seo: seoData as any,
    technical: technicalData,
    technicalSEO: technicalSEO,
    schemaOrg: schemaData,
    accessibility: accessibilityData,
    issues
  };

  const endTime = performance.now();
  return result;
}

function analyzeImages($: CheerioSelector) {
  console.log("Analyzing images...");
  const images = $('img').map((_, el) => {
    const $img = $(el);
    const src = $img.attr('src') || '';
    const alt = $img.attr('alt');
    const title = $img.attr('title');
    const widthAttr = $img.attr('width');
    const heightAttr = $img.attr('height');

    const width = widthAttr ? parseInt(widthAttr) : undefined;
    const height = heightAttr ? parseInt(heightAttr) : undefined;

    return {
      src,
      alt,
      title,
      dimensions: {
        width,
        height
      },
      hasDimensions: !!(width || height)
    };
  }).get();

  const withAlt = images.filter(img => !!img.alt).length;
  const withoutAlt = images.filter(img => !img.alt).length;


  return {
    total: images.length,
    withAlt,
    withoutAlt,
    data: images
  };
}

function analyzeLinks($: CheerioSelector, baseUrl: string) {
  const urlObj = new URL(baseUrl);
  const baseHost = urlObj.hostname;

  const internal = $('a[href]').map((_, el) => {
    const $link = $(el);
    const href = $link.attr('href') || '';
    const text = $link.text().trim();
    const hasImage = $link.find('img').length > 0;

    if (href) {
      try {
        const linkUrl = new URL(href, baseUrl);
        if (linkUrl.hostname === baseHost) {
          return { href, text, hasImage };
        }
      } catch (e) {
        // Ignorer les liens invalides
      }
    }
    return null;
  }).get().filter(Boolean);

  const external = $('a[href]').map((_, el) => {
    const $link = $(el);
    const href = $link.attr('href') || '';
    const text = $link.text().trim();
    const hasImage = $link.find('img').length > 0;

    if (href) {
      try {
        const linkUrl = new URL(href, baseUrl);
        if (linkUrl.hostname !== baseHost) {
          return { href, text, hasImage };
        }
      } catch (e) {
        // Ignorer les liens invalides
      }
    }
    return null;
  }).get().filter(Boolean);

  return { internal, external };
}

function calculateReadabilityScore(text: string): number {
  const sentences = text.split(/[.!?]+/).length;
  const words = text.split(/\s+/).length;
  const syllables = countSyllables(text);

  return 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
}

function countSyllables(text: string): number {
  return text.toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/[^aeiouy]+/g, ' ')
    .trim()
    .split(' ')
    .length;
}

async function getImageSize(url: string): Promise<number> {
  try {
    const response = await axios.head(url);
    return parseInt(response.headers['content-length'] || '0');
  } catch {
    return 0;
  }
}

function checkResponsiveness($: CheerioSelector): boolean {
  return $('meta[name="viewport"]').length > 0 &&
    $('img[srcset], picture, source[srcset]').length > 0;
}

interface SchemaOrgSuggestion {
  type: string;
  properties: Record<string, any>;
  template: string;
}

interface SchemaOrg {
  suggestions: SchemaOrgSuggestion[];
}

interface ExtendedWebsiteAnalysisResult extends WebsiteAnalysisResult {
  schemaOrg: SchemaOrg;
}

function analyzeSchemaOrg(url: string, html: string, $: CheerioSelector, seo: any, contactInfo: Record<string, string> = {}): any {
  try {
    const existing = seo.structuredData || [];
    const suggestions: SchemaOrgSuggestion[] = [];

    const escapeJsonString = (str: string): string => {
      if (!str) return '';
      try {
        return str
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
      } catch (e) {
        console.error('Erreur lors de l\'échappement de chaîne JSON:', e);
        return '';
      }
    };

    try {
      if ($('body').text().toLowerCase().includes('entreprise') ||
        $('body').text().toLowerCase().includes('société') ||
        $('body').text().includes('company')) {

        let orgName = '';
        try {
          orgName = $('meta[property="og:site_name"]').attr('content') || '';

          if (!orgName) {
            const titleParts = seo.title ? seo.title.split(/[|,-]/) : [];
            orgName = titleParts.length > 1 ? titleParts[1]?.trim() : '';
          }

          if (contactInfo?.name && !orgName) {
            orgName = contactInfo.name;
          }
        } catch (e) {
          console.error('Erreur lors de l\'extraction du nom de l\'organisation:', e);
        }

        let logo = '';
        try {
          logo = $('link[rel="icon"]').attr('href') || '';
        } catch (e) {
          console.error('Erreur lors de l\'extraction du logo:', e);
        }

        let phone = '';
        try {
          const phoneMatch = $('body').text().match(/(\+\d{1,3}[-\.\s]??)?\(?\d{3}\)?[-\.\s]??\d{3}[-\.\s]??\d{4}/);
          phone = phoneMatch ? phoneMatch[0] : '';

          if (contactInfo?.telephone && !phone) {
            phone = contactInfo.telephone;
          }
        } catch (e) {
          console.error('Erreur lors de l\'extraction du téléphone:', e);
        }

        const properties: Record<string, any> = {
          "@context": "https://schema.org",
          "@type": "Organization",
          "name": escapeJsonString(orgName || 'Organisation'),
          "url": url
        };

        if (logo) {
          try {
            properties.logo = new URL(logo, url).toString();
          } catch (e) {
            console.error('URL de logo invalide:', logo);
          }
        }

        if (phone) {
          properties.telephone = escapeJsonString(phone);
        }

        if (contactInfo?.email) {
          properties.email = escapeJsonString(contactInfo.email);
        }

        if (contactInfo?.address) {
          properties.address = {
            "@type": "PostalAddress",
            "streetAddress": escapeJsonString(contactInfo.address)
          };
        }

        try {
          const template = `<script type="application/ld+json">\n${JSON.stringify(properties, null, 2)}\n</script>`;

          suggestions.push({
            type: 'Organization',
            properties,
            template
          });
        } catch (e) {
          console.error('Erreur lors de la génération du template JSON pour Organization:', e);
        }
      }
    } catch (orgError) {
      console.error('Erreur lors de l\'analyse des données Organization:', orgError);
    }

    try {
      const websiteProperties: Record<string, any> = {
        "@context": "https://schema.org",
        "@type": "WebSite",
        "name": escapeJsonString(seo.title || 'Site web'),
        "description": escapeJsonString(seo.description || ''),
        "url": url
      };

      if (contactInfo?.email || contactInfo?.telephone) {
        websiteProperties.potentialAction = {
          "@type": "ContactAction",
          "name": "Contact",
          "target": contactInfo?.email ? `mailto:${escapeJsonString(contactInfo.email)}` : url
        };
      }

      const websiteTemplate = `<script type="application/ld+json">\n${JSON.stringify(websiteProperties, null, 2)}\n</script>`;

      suggestions.push({
        type: 'WebSite',
        properties: websiteProperties,
        template: websiteTemplate
      });
    } catch (websiteError) {
      console.error('Erreur lors de la génération du template JSON pour WebSite:', websiteError);
    }

    try {
      if (contactInfo?.address && (contactInfo?.telephone || contactInfo?.email)) {
        const businessName = contactInfo.name || seo.title || 'Entreprise locale';
        const businessProperties: Record<string, any> = {
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          "name": escapeJsonString(businessName),
          "url": url
        };

        if (contactInfo.telephone) {
          businessProperties.telephone = escapeJsonString(contactInfo.telephone);
        }

        if (contactInfo.email) {
          businessProperties.email = escapeJsonString(contactInfo.email);
        }

        if (contactInfo.address) {
          businessProperties.address = {
            "@type": "PostalAddress",
            "streetAddress": escapeJsonString(contactInfo.address)
          };
        }

        const localBusinessTemplate = `<script type="application/ld+json">\n${JSON.stringify(businessProperties, null, 2)}\n</script>`;

        suggestions.push({
          type: 'LocalBusiness',
          properties: businessProperties,
          template: localBusinessTemplate
        });
      }
    } catch (localBusinessError) {
      console.error('Erreur lors de la génération du template JSON pour LocalBusiness:', localBusinessError);
    }

    return { suggestions };
  } catch (e) {
    console.error('Erreur lors de l\'analyse Schema.org:', e);
    return { suggestions: [] };
  }
}

function calculateKeywordDensity(text: string): Record<string, number> {
  const words = text.toLowerCase().split(/\s+/);
  const wordCount = words.length;
  const density: Record<string, number> = {};

  words.forEach(word => {
    word = word.replace(/[^a-z0-9]/g, '');
    if (word.length > 3) {
      density[word] = ((density[word] || 0) + 1) / wordCount;
    }
  });

  return density;
}

async function checkSitemap(baseUrl: string): Promise<{ found: boolean; url?: string; content?: string; urls?: number }> {
  try {
    const possibleLocations = [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/sitemap/',
      '/sitemap.php',
      '/sitemap.txt'
    ];

    for (const location of possibleLocations) {
      try {
        const url = new URL(location, baseUrl).href;
        const response = await axios.get(url, { timeout: 5000 });

        if (response.status === 200 && response.data) {
          const content = response.data;

          if (typeof content === 'string' &&
            (content.includes('<urlset') || content.includes('<sitemapindex'))) {

            const $ = cheerioLoad(content);
            const urlCount = $('url').length;

            return {
              found: true,
              url,
              content,
              urls: urlCount
            };
          }
        }
      } catch (error) {
        console.log(`Sitemap non trouvé à ${location}: ${error.message}`);
      }
    }

    return { found: false };
  } catch (error) {
    console.error('Erreur lors de la vérification du sitemap:', error);
    return { found: false };
  }
}

async function checkRobotsTxt(baseUrl: string): Promise<{ found: boolean; content?: string }> {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const response = await axios.get(robotsUrl, { timeout: 5000 });

    if (response.status === 200 && response.data) {
      return {
        found: true,
        content: response.data
      };
    }

    return { found: false };
  } catch (error) {
    console.error('Erreur lors de la vérification du robots.txt:', error);
    return { found: false };
  }
}

function standardizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname !== "/" && urlObj.pathname.endsWith("/")) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    return urlObj.toString();
  } catch (e) {
    return url;
  }
}

function toggleSlash(url: string): string | null {
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname === "/") {
      return url.replace(/\/$/, "");
    } else if (!urlObj.pathname.endsWith("/")) {
      return url + "/";
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function crawlWebsite(baseUrl: string, maxPages: number = 50): Promise<string[]> {
  console.log(`Démarrage du crawl de ${baseUrl}, limite de ${maxPages} pages`);

  try {
    let normalizedUrl = standardizeUrl(baseUrl);
    console.log(`URL standardisée: ${normalizedUrl}`);

    const protectedRoutes = [
      '/dashboard',
      '/profile',
      '/settings',
      '/projects',
      '/account',
      '/admin',
      '/user',
      '/workspace',
      '/billing',
      '/analytics',
      '/notifications'
    ];

    const allDiscoveredUrls = new Set<string>();
    const visited = new Set<string>();

    allDiscoveredUrls.add(normalizedUrl);
    visited.add(normalizedUrl);

    const alternateUrl = toggleSlash(normalizedUrl);
    if (alternateUrl) {
      allDiscoveredUrls.add(alternateUrl);
      visited.add(alternateUrl);
      console.log(`Version alternative ajoutée: ${alternateUrl}`);
    }

    let mainPageHtml = '';
    try {
      const checkResponse = await axios.get(normalizedUrl, {
        timeout: 5000,
        maxRedirects: 3,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });

      if (checkResponse.status !== 200) {
        console.log(`URL principale inaccessible: ${normalizedUrl}, statut: ${checkResponse.status}`);
        return [normalizedUrl];
      }

      mainPageHtml = checkResponse.data;
    } catch (initialError) {
      console.error(`URL principale inaccessible: ${normalizedUrl}`, initialError.message);
      return [normalizedUrl];
    }

    const queue: string[] = [];
    const skippedUrls: string[] = [];

    try {
      const baseUrlObj = new URL(normalizedUrl);
      const baseHostname = baseUrlObj.hostname;

      function shouldKeepWithoutVisiting(url: string): boolean {
        try {
          const urlObj = new URL(url);
          const path = urlObj.pathname.toLowerCase();

          const authProtectedPaths = [
            '/dashboard',
            '/admin',
            '/account',
            '/profile',
            '/user',
            '/member',
            '/login',
            '/signin',
            '/signup',
            '/register',
            '/checkout',
            '/cart',
            '/orders',
            '/settings'
          ];

          return authProtectedPaths.some(protectedPath => path.includes(protectedPath));
        } catch (e) {
          return false;
        }
      }

      const extractLinks = ($: CheerioSelector, pageUrl: string): string[] => {
        const links: string[] = [];

        $('a[href]').each((_, element) => {
          const href = $(element).attr('href');
          if (href) {
            try {
              const url = normalizeUrl(href, pageUrl, baseUrlObj);
              if (url) links.push(url);
            } catch (e) { }
          }
        });

        $('[to], [href], [data-href], [data-to], [routerlink]').each((_, element) => {
          const $el = $(element);
          if ($el.is('a')) return;

          const linkAttr = $el.attr('to') || $el.attr('data-href') ||
            $el.attr('data-to') || $el.attr('routerlink') ||
            $el.attr('data-routerlink');

          if (linkAttr) {
            try {
              const url = normalizeUrl(linkAttr, pageUrl, baseUrlObj);
              if (url) links.push(url);
            } catch (e) { }
          }
        });

        const scriptTags = $('script').filter((_, el) => {
          const content = $(el).html() || '';
          return (content.includes('__NUXT__') || content.includes('__NEXT_DATA__') ||
            content.includes('window.__PRELOADED_STATE__') || content.includes('routes'));
        });

        scriptTags.each((_, script) => {
          const content = $(script).html() || '';
          const urlMatches = content.match(/"(\/[^"]*?)"/g) || [];
          const httpMatches = content.match(/"(https?:\/\/[^"]*?)"/g) || [];

          [...urlMatches, ...httpMatches].forEach(match => {
            try {
              const cleanMatch = match.replace(/^"|"$/g, '');
              const url = normalizeUrl(cleanMatch, pageUrl, baseUrlObj);
              if (url) links.push(url);
            } catch (e) { }
          });
        });

        $('nav a, .nav a, .menu a, .navigation a, header a, footer a').each((_, element) => {
          const href = $(element).attr('href');
          if (href) {
            try {
              const url = normalizeUrl(href, pageUrl, baseUrlObj);
              if (url) links.push(url);
            } catch (e) { }
          }
        });

        return [...new Set(links)];
      };

      const normalizeUrl = (href: string, currentUrl: string, baseUrlObj: URL): string | null => {
        if (!href) return null;

        try {
          let fullUrl: string;

          if (href.startsWith('http')) {
            const urlObj = new URL(href);
            if (urlObj.hostname !== baseHostname) return null;
            fullUrl = href;
          } else if (href.startsWith('/')) {
            fullUrl = new URL(href, baseUrl).toString();
          } else if (!href.startsWith('#') && !href.startsWith('javascript:') &&
            !href.startsWith('mailto:') && !href.startsWith('tel:')) {
            fullUrl = new URL(href, currentUrl).toString();
          } else {
            return null;
          }

          const cleanUrl = fullUrl.split('#')[0];

          return standardizeUrl(cleanUrl);
        } catch (e) {
          return null;
        }
      };

      if (mainPageHtml) {
        const $ = cheerioLoad(mainPageHtml);
        const mainPageLinks = extractLinks($, normalizedUrl);

        mainPageLinks.forEach(link => {
          const standardizedLink = standardizeUrl(link);
          allDiscoveredUrls.add(standardizedLink);

          if (shouldKeepWithoutVisiting(standardizedLink)) {
            skippedUrls.push(standardizedLink);
            console.log(`URL protégée détectée (non visitée): ${standardizedLink}`);
          } else if (!visited.has(standardizedLink) && !queue.includes(standardizedLink)) {
            queue.push(standardizedLink);
          }
        });

        console.log(`${mainPageLinks.length} liens trouvés sur la page principale`);
      }

      const timeoutPromise = new Promise<string[]>((resolve) => {
        setTimeout(() => {
          console.log(`Timeout du crawl atteint après 15 secondes`);
          return resolve([...Array.from(visited), ...skippedUrls]);
        }, 15000);
      });

      const crawlPromise = new Promise<string[]>(async (resolve) => {
        let crawlCount = 0;
        const maxCrawlAttempts = Math.min(10, maxPages);

        while (queue.length > 0 && visited.size < maxPages && crawlCount < maxCrawlAttempts) {
          const currentUrl = queue.shift() as string;

          if (visited.has(currentUrl)) {
            continue;
          }

          crawlCount++;
          console.log(`Analyse de ${currentUrl} (${visited.size}/${maxPages}, tentative ${crawlCount}/${maxCrawlAttempts})`);

          try {
            const response = await axios.get(currentUrl, {
              timeout: 5000,
              maxRedirects: 3,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
              },
              validateStatus: (status) => status === 200
            });

            const html = response.data;
            if (!html) continue;

            visited.add(currentUrl);

            const $ = cheerioLoad(html);
            const pageLinks = extractLinks($, currentUrl);

            pageLinks.forEach(link => {
              const standardizedLink = standardizeUrl(link);
              allDiscoveredUrls.add(standardizedLink);

              if (shouldKeepWithoutVisiting(standardizedLink)) {
                if (!visited.has(standardizedLink) && !skippedUrls.includes(standardizedLink)) {
                  skippedUrls.push(standardizedLink);
                  console.log(`URL protégée détectée (non visitée): ${standardizedLink}`);
                }
              } else if (!visited.has(standardizedLink) && !queue.includes(standardizedLink) &&
                queue.length + visited.size < maxPages) {
                queue.push(standardizedLink);
              }
            });

            console.log(`${pageLinks.length} liens trouvés sur ${currentUrl}`);
          } catch (error) {
            console.error(`Erreur lors de l'analyse de ${currentUrl}: ${error.message}`);
          }
        }

        resolve([...Array.from(visited), ...skippedUrls]);
      });

      const result = await Promise.race([crawlPromise, timeoutPromise]);
      return result.length > 0 ? result : [normalizedUrl];
    } catch (e) {
      console.error(`Erreur générale lors du crawl:`, e);
      return [normalizedUrl];
    }
  } catch (error) {
    console.error('Erreur fatale dans crawlWebsite:', error);
    return [baseUrl];
  }
}

export function generateSitemap(urls: string[], imagesData: Record<string, any> = {}): string {
  const date = new Date().toISOString();

  let baseDomain = '';
  try {
    if (urls.length > 0) {
      const firstUrl = urls[0];
      const urlObj = new URL(firstUrl);
      baseDomain = `${urlObj.protocol}//${urlObj.host}`;
    }
  } catch (e) {
    console.error("Erreur lors de l'extraction du domaine de base:", e);
  }

  const uniqueUrls = [...new Set(urls.map(url => standardizeUrl(url)))];

  uniqueUrls.sort((a, b) => {
    try {
      const segmentsA = new URL(a).pathname.split('/').filter(Boolean).length;
      const segmentsB = new URL(b).pathname.split('/').filter(Boolean).length;

      if (segmentsA !== segmentsB) {
        return segmentsA - segmentsB;
      }

      return a.localeCompare(b);
    } catch (e) {
      return 0;
    }
  });

  const getPriorityAndChangefreq = (url: string): { priority: string, changefreq: string } => {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      const segments = path.split('/').filter(Boolean);

      if (path === '/' || path === '') {
        return { priority: '1.0', changefreq: 'daily' };
      }

      if (segments.length === 1) {
        if (['about', 'contact', 'services', 'products', 'blog'].includes(segments[0])) {
          return { priority: '0.8', changefreq: 'weekly' };
        }
        return { priority: '0.7', changefreq: 'weekly' };
      }

      if (segments.includes('dashboard') || segments.includes('admin') ||
        segments.includes('profile') || segments.includes('account')) {
        return { priority: '0.9', changefreq: 'daily' };
      }

      if (segments.length === 2) {
        if (segments[0] === 'blog' || segments[0] === 'products' || segments[0] === 'product') {
          return { priority: '0.6', changefreq: 'monthly' };
        }
        return { priority: '0.5', changefreq: 'monthly' };
      }

      return { priority: '0.3', changefreq: 'monthly' };
    } catch (e) {
      return { priority: '0.5', changefreq: 'monthly' };
    }
  };

  const isImageUrl = (url: string): boolean => {
    return !!url.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i);
  };

  const imageUrls: Record<string, Array<{ url: string, title?: string, alt?: string }>> = {};

  const getAbsoluteImageUrl = (imgSrc: string, pageUrl: string): string => {
    try {
      if (imgSrc.startsWith('http')) {
        return imgSrc;
      } else if (imgSrc.startsWith('//')) {
        const pageUrlObj = new URL(pageUrl);
        return `${pageUrlObj.protocol}${imgSrc}`;
      } else if (imgSrc.startsWith('/')) {
        return `${baseDomain}${imgSrc}`;
      } else {
        return new URL(imgSrc, pageUrl).toString();
      }
    } catch (e) {
      console.error(`Erreur lors de la conversion de l'URL d'image ${imgSrc}:`, e);
      return imgSrc;
    }
  };

  Object.entries(imagesData).forEach(([pageUrl, data]) => {
    try {
      if (data && data.images) {
        if (data.images.data && Array.isArray(data.images.data)) {
          console.log(`Nombre d'images trouvées: ${data.images.data.length}`);

          imageUrls[pageUrl] = data.images.data
            .filter(img => {
              if (!img || !img.src) {
                console.log("Image ignorée (pas de src):", img);
                return false;
              }
              console.log(`Image trouvée: ${img.src}`);
              return true;
            })
            .map(img => {
              const absoluteUrl = getAbsoluteImageUrl(img.src, pageUrl);
              console.log(`  - URL transformée: ${img.src} -> ${absoluteUrl}`);
              return {
                url: absoluteUrl,
                title: img.title || undefined,
                alt: img.alt || undefined
              };
            });
        }
      }
    } catch (e) {
      console.error(`Erreur lors du traitement des images pour ${pageUrl}:`, e);
    }
  });

  const directImageUrls = uniqueUrls.filter(url => isImageUrl(url));
  if (directImageUrls.length > 0) {
    imageUrls['directImages'] = directImageUrls.map(url => ({
      url,
      title: undefined,
      alt: undefined
    }));
  }

  const sitemapEntries = uniqueUrls
    .filter(url => {
      try {
        if (url.match(/\.(css|js|ico|woff|woff2|ttf|eot|pdf|zip|rar|exe|dll|docx?|xlsx?|pptx?)(\?.*)?$/i)) {
          return false;
        }

        if (url.includes('/api/') || url.includes('/wp-json/')) {
          return false;
        }

        if (url.includes('/404') || url.includes('/500') || url.includes('/error')) {
          return false;
        }

        return true;
      } catch (e) {
        return true;
      }
    })
    .map(url => {
      const { priority, changefreq } = getPriorityAndChangefreq(url);
      const urlImages = imageUrls[url] || [];
      const isImage = isImageUrl(url);

      console.log(`Génération du sitemap pour ${url}, nombre d'images: ${urlImages.length}`);

      if (isImage) {
        return `  <url>
    <loc>${url}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
    <image:image>
      <image:loc>${url}</image:loc>
    </image:image>
  </url>`;
      }

      const directImages = imageUrls['directImages'] || [];

      const pageImages = [...urlImages];

      if (url.endsWith('/') || url.split('/').length <= 3) {
        pageImages.push(...directImages);
      }

      for (const [pageUrl, imgs] of Object.entries(imageUrls)) {
        if (pageUrl !== 'directImages' && pageUrl !== url) {
          pageImages.push(...imgs);
        }
      }

      const uniquePageImages = pageImages.filter((img, index, self) =>
        index === self.findIndex(i => i.url === img.url)
      );

      console.log(`Après fusion, nombre total d'images pour ${url}: ${uniquePageImages.length}`);

      const imageSection = uniquePageImages.length > 0
        ? uniquePageImages.map(img => {
          console.log(`  - Ajout de l'image au sitemap: ${img.url}`);
          return `
    <image:image>
      <image:loc>${img.url}</image:loc>${img.title ? `
      <image:title>${img.title}</image:title>` : ''}${img.alt ? `
      <image:caption>${img.alt}</image:caption>` : ''}
    </image:image>`;
        }).join('')
        : '';

      return `  <url>
    <loc>${url}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>${imageSection}
  </url>`;
    }).join('\n');

  const sitemap =
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${sitemapEntries}
</urlset>`;

  return sitemap;
}

function rankPages(results: Record<string, WebsiteAnalysisResult>): string[] {
  return Object.entries(results)
    .sort(([, a], [, b]) => {
      const getScore = (result: WebsiteAnalysisResult) => {
        let score = 0;
        score += (1000 - result.performance.loadTime) / 10;
        score += (100 - result.performance.ttfb) / 2;

        if (result.seo.title) score += 10;
        if (result.seo.description) score += 10;
        score += result.seo.images.withAlt * 2;
        score -= result.issues.length * 5;

        score += result.seo.wordCount / 100;
        score += Object.keys(result.seo.structuredData.types).length * 5;

        return score;
      };

      return getScore(b) - getScore(a);
    })
    .map(([url]) => url);
}

async function findContactInfo(baseUrl: string, links: string[]): Promise<Record<string, string>> {
  if (!links || links.length === 0) {
    console.log('Aucun lien fourni pour la recherche de contact');
    return {};
  }

  try {
    const contactKeywords = ['contact', 'about', 'about-us', 'a-propos', 'qui-sommes-nous', 'equipe', 'team'];

    const baseUrlObj = new URL(baseUrl);
    const baseHostname = baseUrlObj.hostname;

    const prioritizedUrls: string[] = [];

    links.forEach(link => {
      try {
        const url = new URL(link);
        if (url.hostname !== baseHostname) return;

        const path = url.pathname.toLowerCase();
        if (contactKeywords.some(keyword => path.includes(keyword))) {
          prioritizedUrls.push(link);
        }
      } catch (e) {
        console.log(`URL invalide ignorée: ${link}`);
      }
    });

    console.log(`${prioritizedUrls.length} liens potentiels de contact trouvés`);

    if (prioritizedUrls.length === 0) {
      prioritizedUrls.push(baseUrl);
    }

    const contactInfo: Record<string, string> = {};

    const pagesToCheck = prioritizedUrls.slice(0, 3);

    for (const url of pagesToCheck) {
      try {
        const response = await axios.get(url, {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        if (response.status !== 200) {
          console.log(`Page inaccessible: ${url}, statut: ${response.status}`);
          continue;
        }

        const html = response.data;
        if (!html) continue;

        const $ = cheerioLoad(html);

        if (!contactInfo.telephone) {
          $('a[href^="tel:"]').each((_, element) => {
            const tel = $(element).attr('href')?.replace('tel:', '') || '';
            if (tel && tel.length > 5) {
              contactInfo.telephone = tel;
              return false;
            }
          });

          if (!contactInfo.telephone) {
            const phoneRegex = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|(?:\+\d{1,3}[\s.-]?)?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{2}/g;
            const bodyText = $('body').text();
            const matches = bodyText.match(phoneRegex);

            if (matches && matches.length > 0) {
              contactInfo.telephone = matches[0].replace(/\s+/g, ' ').trim();
            }
          }
        }

        if (!contactInfo.email) {
          $('a[href^="mailto:"]').each((_, element) => {
            const email = $(element).attr('href')?.replace('mailto:', '')?.split('?')[0] || '';
            if (email && email.includes('@') && email.includes('.')) {
              contactInfo.email = email;
              return false;
            }
          });

          if (!contactInfo.email) {
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
            const bodyText = $('body').text();
            const matches = bodyText.match(emailRegex);

            if (matches && matches.length > 0) {
              const validEmail = matches.find(email =>
                !email.includes('example') &&
                !email.includes('nom@') &&
                !email.includes('votre') &&
                !email.includes('user')
              );

              if (validEmail) {
                contactInfo.email = validEmail;
              }
            }
          }
        }

        if (!contactInfo.address) {
          $('[itemtype*="PostalAddress"], [itemprop="address"], [itemprop="streetAddress"], .address, .contact-address').each((_, element) => {
            const addressText = $(element).text().trim();
            if (addressText && addressText.length > 10) {
              contactInfo.address = addressText.replace(/\s+/g, ' ');
              return false;
            }
          });

          if (!contactInfo.address) {
            $('p, div').each((_, element) => {
              const text = $(element).text().trim();
              if (
                (text.match(/\d{5}/) || text.match(/\d{2,4}\s+\w+/)) &&
                (text.includes('rue') || text.includes('avenue') || text.includes('boulevard') ||
                  text.includes('chemin') || text.includes('place') || text.includes('route'))
              ) {
                if (text.length > 10 && text.length < 200) {
                  contactInfo.address = text.replace(/\s+/g, ' ');
                  return false;
                }
              }
            });
          }
        }

        if (!contactInfo.name) {
          $('[itemtype*="Organization"], [itemtype*="Person"]').each((_, element) => {
            const nameEl = $(element).find('[itemprop="name"]');
            if (nameEl.length > 0) {
              contactInfo.name = nameEl.first().text().trim();
              return false;
            }
          });

          if (!contactInfo.name) {
            const siteName = $('title').text().split('|')[0].split('-')[0].trim();
            if (siteName && siteName.length > 1) {
              contactInfo.name = siteName;
            }
          }

          if (!contactInfo.name) {
            contactInfo.name = baseHostname.replace('www.', '');
          }
        }

        if (contactInfo.telephone && contactInfo.email && contactInfo.address && contactInfo.name) {
          break;
        }
      } catch (error) {
        console.error(`Erreur lors de l'analyse de ${url} pour les contacts:`, error.message);
      }
    }

    console.log('Informations de contact trouvées:', contactInfo);
    return contactInfo;
  } catch (error) {
    console.error('Erreur générale lors de la recherche de contacts:', error);
    return {};
  }
}

async function createFallbackResult(url: string): Promise<WebsiteAnalysisResult> {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    return {
      url,
      performance: {
        ttfb: 0,
        fcp: 0,
        lcp: 0,
        cls: 0,
        speedIndex: 0,
        totalBlockingTime: 0,
        loadTime: 0,
        resourceLoadTimes: {
          total: 0,
          html: 0,
          css: 0,
          js: 0,
          images: 0,
          other: 0
        },
        resourceSizes: {
          total: 0,
          html: 0,
          css: 0,
          js: 0,
          images: 0,
          other: 0
        }
      },
      seo: {
        title: '',
        description: '',
        headings: { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] },
        images: { total: 0, withAlt: 0, withoutAlt: 0, data: [] as any[] },
        links: {
          internal: [] as Array<{ href: string; text: string; hasImage: boolean }>,
          external: [] as Array<{ href: string; text: string; hasImage: boolean }>,
          broken: [] as string[],
          nofollow: [] as string[]
        },
        structuredData: { data: [] as any[], count: 0, types: {} },
        meta: {
          viewport: false,
          robots: '',
          canonical: '',
          og: {},
          twitter: {}
        },
        wordCount: 0,
        readabilityScore: 0,
        keywordDensity: {}
      },
      technical: {
        statusCode: 0,
        https: url.startsWith('https'),
        mobile: {
          viewport: false,
          responsive: false
        },
        security: {
          headers: {},
          securityIssues: []
        },
        meta: {
          charset: '',
          language: '',
          viewport: '',
          themeColor: ''
        },
        response: {
          headers: {},
          size: 0,
          time: 0
        }
      },
      accessibility: {
        missingAria: 0,
        missingAlt: 0,
        missingLabels: 0,
        missingInputAttributes: 0,
        contrastIssues: 0,
        ariaIssues: [],
        inputIssues: [],
        accessibilityScore: 0
      },
      technicalSEO: {
        sitemapFound: false,
        robotsTxtFound: false,
        schemaTypeCount: {}
      },
      issues: []
    };
  } catch (e) {
    console.error('Erreur lors de la création du résultat de secours:', e);
    throw e;
  }
}

function analyzeAccessibility($: CheerioSelector): {
  missingAria: number;
  missingAlt: number;
  missingLabels: number;
  missingInputAttributes: number;
  contrastIssues: number;
  ariaIssues: Array<{ element: string, issue: string }>;
  inputIssues: Array<{ element: string, issue: string }>;
  accessibilityScore: number;
} {
  // Vérifier les images sans attribut alt
  const images = $('img');
  const imagesWithoutAlt = $('img:not([alt])');
  const missingAlt = imagesWithoutAlt.length;


  const imagesWithoutAltDetails: Array<{ element: string, src: string }> = [];
  imagesWithoutAlt.each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || 'without source';
    imagesWithoutAltDetails.push({
      element: `<img src="${src}" ...>`,
      src
    });
  });

  const ariaElements = $('[role]');
  let missingAria = 0;
  const ariaIssues: Array<{ element: string, issue: string }> = [];


  const ariaRoles = [
    { role: 'button', requiredAttrs: ['aria-pressed', 'aria-expanded', 'aria-disabled'] },
    { role: 'checkbox', requiredAttrs: ['aria-checked'] },
    { role: 'combobox', requiredAttrs: ['aria-expanded', 'aria-controls'] },
    { role: 'dialog', requiredAttrs: ['aria-labelledby', 'aria-describedby'] },
    { role: 'menu', requiredAttrs: ['aria-labelledby'] },
    { role: 'menuitem', requiredAttrs: ['aria-disabled'] },
    { role: 'option', requiredAttrs: ['aria-selected'] },
    { role: 'progressbar', requiredAttrs: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'] },
    { role: 'scrollbar', requiredAttrs: ['aria-controls', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax'] },
    { role: 'slider', requiredAttrs: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'] },
    { role: 'tab', requiredAttrs: ['aria-selected'] },
    { role: 'tabpanel', requiredAttrs: ['aria-labelledby'] },
    { role: 'textbox', requiredAttrs: ['aria-multiline', 'aria-readonly'] }
  ];

  ariaElements.each((_, el) => {
    const $el = $(el);
    const role = $el.attr('role');
    const tagName = el.type === 'tag' ? el.tagName : 'div';

    if (!role) return;

    // Trouver le rôle correspondant dans notre liste
    const ariaRole = ariaRoles.find(r => r.role === role);
    if (ariaRole) {
      // Vérifier que les attributs requis sont présents
      const missingAttrs = ariaRole.requiredAttrs.filter(attr => !$el.attr(attr));
      if (missingAttrs.length > 0) {
        missingAria++;
        ariaIssues.push({
          element: `<${tagName} role="${role}"...>`,
          issue: `Attributs manquants pour rôle "${role}": ${missingAttrs.join(', ')}`
        });
      }
    }
  });

  // Vérifier les éléments avec des attributs ARIA mal utilisés
  const ariaAttributes = [
    'aria-activedescendant', 'aria-atomic', 'aria-autocomplete', 'aria-busy', 'aria-checked',
    'aria-controls', 'aria-current', 'aria-describedby', 'aria-disabled', 'aria-dropeffect',
    'aria-expanded', 'aria-flowto', 'aria-grabbed', 'aria-haspopup', 'aria-hidden',
    'aria-invalid', 'aria-label', 'aria-labelledby', 'aria-level', 'aria-live',
    'aria-multiline', 'aria-multiselectable', 'aria-orientation', 'aria-owns', 'aria-posinset',
    'aria-pressed', 'aria-readonly', 'aria-relevant', 'aria-required', 'aria-selected',
    'aria-setsize', 'aria-sort', 'aria-valuemax', 'aria-valuemin', 'aria-valuenow', 'aria-valuetext'
  ];

  // Vérifier les attributs aria qui nécessitent des rôles spécifiques
  const ariaRoleMap = {
    'aria-checked': ['checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio', 'switch'],
    'aria-expanded': ['button', 'combobox', 'document', 'link', 'menu', 'menuitem', 'select'],
    'aria-selected': ['option', 'row', 'tab'],
    'aria-pressed': ['button'],
    'aria-valuemax': ['progressbar', 'scrollbar', 'slider', 'spinbutton'],
    'aria-valuemin': ['progressbar', 'scrollbar', 'slider', 'spinbutton'],
    'aria-valuenow': ['progressbar', 'scrollbar', 'slider', 'spinbutton'],
    'aria-required': ['combobox', 'textbox', 'select', 'grid', 'listbox']
  };

  Object.entries(ariaRoleMap).forEach(([ariaAttr, validRoles]) => {
    $(`[${ariaAttr}]`).each((_, el) => {
      const $el = $(el);
      const role = $el.attr('role');

      if (!role || !validRoles.includes(role)) {
        const tagName = el.type === 'tag' ? el.tagName : 'div';
        missingAria++;
        ariaIssues.push({
          element: `<${tagName} ${ariaAttr}="..."...>`,
          issue: `Attribut ${ariaAttr} utilisé sans rôle approprié: ${validRoles.join(', ')}`
        });
      }
    });
  });

  // Vérifier les champs de formulaire sans label associé
  const inputs = $('input[type="text"], input[type="email"], input[type="password"], input[type="number"], input[type="tel"], textarea, select');
  let missingLabels = 0;
  const inputIssues: Array<{ element: string, issue: string }> = [];

  inputs.each((_, el) => {
    const $el = $(el);
    const tagName = el.type === 'tag' ? el.tagName : 'input';
    const id = $el.attr('id');

    if (!id) {
      // Vérifier si une autre méthode d'accessibilité est utilisée
      const hasAriaLabel = $el.attr('aria-label');
      const hasAriaLabelledby = $el.attr('aria-labelledby');

      if (!hasAriaLabel && !hasAriaLabelledby) {
        missingLabels++;
        inputIssues.push({
          element: `<${tagName}...>`,
          issue: 'Champ sans attribut id, aria-label ou aria-labelledby pour l\'accessibilité'
        });
      }
    } else {
      const hasLabel = $(`label[for="${id}"]`).length > 0;
      if (!hasLabel) {
        missingLabels++;
        inputIssues.push({
          element: `<${tagName} id="${id}"...>`,
          issue: 'Champ avec id mais sans label associé'
        });
      }
    }
  });

  // Vérifier les attributs des champs de formulaire
  let missingInputAttributes = 0;
  inputs.each((_, el) => {
    const $el = $(el);
    const tagName = el.type === 'tag' ? el.tagName : 'input';
    const type = $el.attr('type');

    // Vérifier les attributs requis par type
    if (!$el.attr('name')) {
      missingInputAttributes++;
      inputIssues.push({
        element: `<${tagName}...>`,
        issue: 'Champ sans attribut name'
      });
    }

    // Vérifier les attributs d'accessibilité pour chaque type
    if (type === 'text' || type === 'email' || type === 'password' || type === 'tel') {
      const hasPlaceholder = $el.attr('placeholder');
      const hasAriaLabel = $el.attr('aria-label');
      const hasAriaLabelledby = $el.attr('aria-labelledby');
      const hasId = $el.attr('id');
      const hasAssociatedLabel = hasId && $(`label[for="${hasId}"]`).length > 0;

      if (!hasPlaceholder && !hasAriaLabel && !hasAriaLabelledby && !hasAssociatedLabel) {
        missingInputAttributes++;
        inputIssues.push({
          element: `<${tagName} type="${type}"...>`,
          issue: 'Champ sans méthode d\'identification accessible (placeholder, aria-label, aria-labelledby, ou label associé)'
        });
      }
    }
  });

  // Vérifier les éléments interactifs avec des problèmes d'accessibilité
  const interactiveElements = $('button, a[href], [role="button"], [role="link"], [onclick]');
  interactiveElements.each((_, el) => {
    const $el = $(el);
    const tagName = el.type === 'tag' ? el.tagName : 'div';

    // Vérifier que les éléments interactifs ont un texte ou une alternative
    const hasTextContent = $el.text().trim().length > 0;
    const hasAriaLabel = $el.attr('aria-label');
    const hasAriaLabelledby = $el.attr('aria-labelledby');
    const hasTitle = $el.attr('title');

    if (!hasTextContent && !hasAriaLabel && !hasAriaLabelledby && !hasTitle) {
      missingAria++;
      ariaIssues.push({
        element: `<${tagName}...>`,
        issue: 'Élément interactif sans texte ou alternative accessible (aria-label, aria-labelledby, title)'
      });
    }
  });

  // Vérifier les titres de niveau (h1-h6) pour la structure hiérarchique
  let previousLevel = 0;
  for (let i = 1; i <= 6; i++) {
    const headings = $(`h${i}`);
    if (i === 1 && headings.length === 0) {
      ariaIssues.push({
        element: '<h1>',
        issue: 'Aucun titre h1 trouvé sur la page. Le niveau h1 est essentiel pour la structure de la page.'
      });
      missingAria++;
    } else if (i > 1 && previousLevel === 0 && headings.length > 0) {
      ariaIssues.push({
        element: `<h${i}>`,
        issue: `Titre h${i} utilisé sans h${i - 1} précédent. Les niveaux de titre doivent être utilisés dans l'ordre.`
      });
      missingAria++;
    }

    // Mettre à jour le niveau précédent s'il y a des titres à ce niveau
    if (headings.length > 0) {
      previousLevel = i;
    }
  }

  // Pour l'analyse des contrastes, nous ne pouvons pas facilement le faire côté serveur
  // car cela nécessite des informations CSS calculées. On met une valeur par défaut.
  const contrastIssues = 0;

  // Calculer un score d'accessibilité basé sur les problèmes trouvés
  const totalIssues = missingAria + missingAlt + missingLabels + missingInputAttributes + contrastIssues;
  const totalElements = Math.max(1, images.length + ariaElements.length + inputs.length + interactiveElements.length);

  // Calcul du score d'accessibilité plus nuancé
  let accessibilityScore = 100;

  if (totalElements > 0 && totalIssues > 0) {
    // Pénalités pour chaque type de problème
    if (missingAlt > 0) {
      // Plus grave pour les images sans alt
      accessibilityScore -= Math.min(25, (missingAlt / Math.max(1, images.length)) * 100);
    }

    if (missingAria > 0) {
      accessibilityScore -= Math.min(20, (missingAria / Math.max(1, ariaElements.length + interactiveElements.length)) * 100);
    }

    if (missingLabels > 0 || missingInputAttributes > 0) {
      accessibilityScore -= Math.min(30, ((missingLabels + missingInputAttributes) / Math.max(1, inputs.length)) * 100);
    }
  }

  // S'il n'y a aucun élément à vérifier, le score est parfait
  if (totalElements <= 1 && totalIssues === 0) {
    accessibilityScore = 100;
  }

  // Arrondir et s'assurer que le score est entre 0 et 100
  accessibilityScore = Math.max(0, Math.min(100, Math.round(accessibilityScore)));

  return {
    missingAria,
    missingAlt,
    missingLabels,
    missingInputAttributes,
    contrastIssues,
    ariaIssues,
    inputIssues,
    accessibilityScore
  };
}

function generateSEOIssues(seoData: any, performanceData: any): Array<{ type: string; message: string; severity: 'critical' | 'high' | 'medium' | 'low' }> {
  const issues: Array<{ type: string; message: string; severity: 'critical' | 'high' | 'medium' | 'low' }> = [];

  if (!seoData.title) {
    issues.push({
      type: 'error',
      message: 'Titre manquant',
      severity: 'high'
    });
  }

  if (!seoData.description) {
    issues.push({
      type: 'warning',
      message: 'Description meta manquante',
      severity: 'medium'
    });
  }

  if (seoData.images && seoData.images.withoutAlt > 0) {
    issues.push({
      type: 'warning',
      message: `${seoData.images.withoutAlt} image(s) sans attribut alt`,
      severity: 'medium'
    });
  }

  if (performanceData && performanceData.loadTime > 3000) {
    issues.push({
      type: 'warning',
      message: 'Temps de chargement élevé',
      severity: 'medium'
    });
  }

  return issues;
}


export function analyzeMetaTags($: CheerioSelector, url: string): {
  score: number;
  essential: Array<{ name: string; present: boolean; content?: string }>;
  social: Array<{ name: string; present: boolean; content?: string }>;
  issues: Array<{ tagName: string; issue: string; recommendation: string; example?: string; severity: string }>;
  metaHtml: string;
} {
  const metaTags = $('meta').toArray();
  const title = $('title').text().trim();
  const metaTagsHtml = metaTags.map(tag => $.html(tag)).join('\n');

  // Check for essential meta tags
  const essentialTags = [
    { name: 'Title', present: title.length > 0, content: title },
    { name: 'Description', present: $('meta[name="description"]').length > 0, content: $('meta[name="description"]').attr('content') || '' },
    { name: 'Viewport', present: $('meta[name="viewport"]').length > 0, content: $('meta[name="viewport"]').attr('content') || '' },
    { name: 'Charset', present: $('meta[charset]').length > 0 || $('meta[http-equiv="Content-Type"]').length > 0, content: $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content') || '' },
    { name: 'Robots', present: $('meta[name="robots"]').length > 0, content: $('meta[name="robots"]').attr('content') || '' },
    { name: 'Canonical', present: $('link[rel="canonical"]').length > 0, content: $('link[rel="canonical"]').attr('href') || '' },
  ];

  // Check for social media tags
  const socialTags = [
    { name: 'og:title', present: $('meta[property="og:title"]').length > 0, content: $('meta[property="og:title"]').attr('content') || '' },
    { name: 'og:description', present: $('meta[property="og:description"]').length > 0, content: $('meta[property="og:description"]').attr('content') || '' },
    { name: 'og:image', present: $('meta[property="og:image"]').length > 0, content: $('meta[property="og:image"]').attr('content') || '' },
    { name: 'og:url', present: $('meta[property="og:url"]').length > 0, content: $('meta[property="og:url"]').attr('content') || '' },
    { name: 'og:type', present: $('meta[property="og:type"]').length > 0, content: $('meta[property="og:type"]').attr('content') || '' },
    { name: 'twitter:card', present: $('meta[name="twitter:card"]').length > 0, content: $('meta[name="twitter:card"]').attr('content') || '' },
    { name: 'twitter:title', present: $('meta[name="twitter:title"]').length > 0, content: $('meta[name="twitter:title"]').attr('content') || '' },
    { name: 'twitter:description', present: $('meta[name="twitter:description"]').length > 0, content: $('meta[name="twitter:description"]').attr('content') || '' },
    { name: 'twitter:image', present: $('meta[name="twitter:image"]').length > 0, content: $('meta[name="twitter:image"]').attr('content') || '' },
  ];

  // Identify missing or problematic meta tags
  const issues: Array<{ tagName: string, issue: string, recommendation: string, example?: string, severity: string }> = [];

  if (!title || title.length < 10 || title.length > 60) {
    issues.push({
      tagName: 'title',
      issue: 'Title tag is missing or has improper length',
      recommendation: 'Add a descriptive title between 10-60 characters',
      example: '<title>Your Descriptive Page Title | Brand Name</title>',
      severity: 'critical'
    });
  }

  const descriptionTag = $('meta[name="description"]');
  if (!descriptionTag.length) {
    issues.push({
      tagName: 'meta description',
      issue: 'Meta description is missing',
      recommendation: 'Add a descriptive meta description between 50-160 characters',
      example: '<meta name="description" content="A compelling description of your page content that includes relevant keywords">',
      severity: 'high'
    });
  } else {
    const descriptionContent = descriptionTag.attr('content') || '';
    if (descriptionContent.length < 50 || descriptionContent.length > 160) {
      issues.push({
        tagName: 'meta description',
        issue: 'Meta description has improper length',
        recommendation: 'Meta description should be between 50-160 characters for optimal display in search results',
        severity: 'medium'
      });
    }
  }

  if (!$('meta[name="viewport"]').length) {
    issues.push({
      tagName: 'meta viewport',
      issue: 'Viewport meta tag is missing',
      recommendation: 'Add a viewport meta tag for better mobile responsiveness',
      example: '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      severity: 'high'
    });
  }

  if (!$('meta[charset]').length && !$('meta[http-equiv="Content-Type"]').length) {
    issues.push({
      tagName: 'meta charset',
      issue: 'Character encoding meta tag is missing',
      recommendation: 'Add a charset meta tag',
      example: '<meta charset="UTF-8">',
      severity: 'high'
    });
  }

  if (!$('link[rel="canonical"]').length) {
    issues.push({
      tagName: 'canonical link',
      issue: 'Canonical link is missing',
      recommendation: 'Add a canonical link to prevent duplicate content issues',
      example: `<link rel="canonical" href="${url}">`,
      severity: 'medium'
    });
  }

  // Calculate score based on essential and social tags presence
  const essentialCount = essentialTags.filter(tag => tag.present).length;
  const essentialScore = (essentialCount / essentialTags.length) * 100;

  const socialCount = socialTags.filter(tag => tag.present).length;
  const socialScore = (socialCount / socialTags.length) * 100;

  const issuesScore = Math.max(0, 100 - (issues.length * 10));

  const finalScore = Math.min(100, Math.round((essentialScore * 0.6) + (socialScore * 0.3) + (issuesScore * 0.1)));

  return {
    score: finalScore,
    essential: essentialTags,
    social: socialTags,
    issues: issues,
    metaHtml: metaTagsHtml
  };
}

export function analyzeAriaAttributes($: CheerioSelector): {
  score: number;
  missingAriaCount: number;
  missingLabels: number;
  invalidAriaCount: number;
  interactiveElementsCount: number;
  interactiveElementsWithAriaPercent: number;
  formElementsCount: number;
  formElementsWithLabelsPercent: number;
  issues: Array<{ element: string; issue: string; suggestion: string; code?: string; severity: string }>;
} {
  // Interactive elements that should have ARIA roles or attributes
  const interactiveElements = $('button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]');
  const interactiveElementsCount = interactiveElements.length;

  // Form elements that should have labels
  const formElements = $('input, select, textarea');
  const formElementsCount = formElements.length;

  let missingAriaCount = 0;
  let invalidAriaCount = 0;
  let missingLabels = 0;

  const interactiveElementsWithAria = interactiveElements.filter(function () {
    const element = $(this);
    const tagName = element.prop('tagName')?.toLowerCase() || '';
    const hasAriaRole = element.attr('role') !== undefined;
    const hasAriaLabel = element.attr('aria-label') !== undefined || element.attr('aria-labelledby') !== undefined;

    // Check if element has appropriate ARIA attributes
    if (!hasAriaRole && !hasAriaLabel && tagName !== 'a' && tagName !== 'button') {
      missingAriaCount++;
      return false;
    }

    return true;
  }).length;

  const formElementsWithLabels = formElements.filter(function () {
    const element = $(this);
    const id = element.attr('id');
    const hasExplicitLabel = id ? $(`label[for="${id}"]`).length > 0 : false;
    const hasAriaLabel = element.attr('aria-label') !== undefined || element.attr('aria-labelledby') !== undefined;

    if (!hasExplicitLabel && !hasAriaLabel) {
      missingLabels++;
      return false;
    }

    return true;
  }).length;

  // Check for elements with invalid ARIA attributes
  $('[aria-labelledby]').each(function () {
    const labelledby = $(this).attr('aria-labelledby');
    if (labelledby && !labelledby.includes('{{') && !labelledby.includes('}}')) {
      try {
        // Utiliser une méthode plus sûre pour vérifier l'existence de l'élément
        const idSelector = labelledby.split(' ').map(id => `#${id.replace(/['"\\]/g, '\\$&')}`).join(', ');
        if (idSelector && $(idSelector).length === 0) {
          invalidAriaCount++;
        }
      } catch (error) {
        console.error('Erreur lors du traitement du sélecteur aria-labelledby:', error);
      }
    }
  });

  // Calculate percentages
  const interactiveElementsWithAriaPercent = interactiveElementsCount > 0 ?
    Math.round((interactiveElementsWithAria / interactiveElementsCount) * 100) : 100;

  const formElementsWithLabelsPercent = formElementsCount > 0 ?
    Math.round((formElementsWithLabels / formElementsCount) * 100) : 100;

  // Collect issues
  const issues: Array<{ element: string; issue: string; suggestion: string; code?: string; severity: string }> = [];

  // Check for missing alt attributes on images
  $('img').each(function () {
    const img = $(this);
    if (!img.attr('alt') && !img.attr('role') && !img.attr('aria-hidden')) {
      issues.push({
        element: '<img>',
        issue: 'Image missing alt attribute',
        suggestion: 'Add an alt attribute to provide alternative text for screen readers. Use empty alt="" for decorative images.',
        code: $.html(this),
        severity: 'critical'
      });
    }
  });

  // Check for form elements without labels
  $('input, select, textarea').each(function () {
    const element = $(this);
    const id = element.attr('id');
    const type = element.attr('type')?.toLowerCase();

    // Skip hidden and submit inputs
    if (type === 'hidden' || type === 'submit' || type === 'button') {
      return;
    }

    const hasExplicitLabel = id ? $(`label[for="${id}"]`).length > 0 : false;
    const hasAriaLabel = element.attr('aria-label') !== undefined || element.attr('aria-labelledby') !== undefined;

    if (!hasExplicitLabel && !hasAriaLabel) {
      issues.push({
        element: `<${element.prop('tagName')?.toLowerCase() || 'input'}>`,
        issue: 'Form control without a label',
        suggestion: 'Add a proper label tag with a "for" attribute or an aria-label for this form control.',
        code: $.html(this),
        severity: 'critical'
      });
    }
  });

  // Check for anchor tags without href
  $('a').each(function () {
    if (!$(this).attr('href') && !$(this).attr('role')) {
      issues.push({
        element: '<a>',
        issue: 'Anchor tag without href attribute',
        suggestion: 'Add an href attribute or a role attribute for anchors used as buttons.',
        code: $.html(this),
        severity: 'warning'
      });
    }
  });

  // Check for buttons without text
  $('button').each(function () {
    const button = $(this);
    const buttonText = button.text().trim();
    const hasAriaLabel = button.attr('aria-label') !== undefined || button.attr('aria-labelledby') !== undefined;

    if (buttonText === '' && !hasAriaLabel) {
      issues.push({
        element: '<button>',
        issue: 'Button without text or ARIA label',
        suggestion: 'Add text content or an aria-label attribute to the button.',
        code: $.html(this),
        severity: 'critical'
      });
    }
  });

  // Check for invalid ARIA references
  $('[aria-labelledby]').each(function () {
    const labelledby = $(this).attr('aria-labelledby');
    if (labelledby && !labelledby.includes('{{') && !labelledby.includes('}}')) {
      try {
        // Utiliser une méthode plus sûre pour vérifier l'existence de l'élément
        const idSelector = labelledby.split(' ').map(id => `#${id.replace(/['"\\]/g, '\\$&')}`).join(', ');
        if (idSelector && $(idSelector).length === 0) {
          issues.push({
            element: $(this).prop('tagName')?.toLowerCase() || 'element',
            issue: `Invalid aria-labelledby reference: #${labelledby} does not exist`,
            suggestion: 'Ensure aria-labelledby references an existing element ID.',
            code: $.html(this),
            severity: 'critical'
          });
        }
      } catch (error) {
        console.error('Erreur lors du traitement du sélecteur aria-labelledby:', error);
      }
    }
  });

  // Calculate score
  const missingAriaScore = interactiveElementsCount > 0 ?
    Math.min(100, 100 - (missingAriaCount / interactiveElementsCount * 100)) : 100;

  const missingLabelsScore = formElementsCount > 0 ?
    Math.min(100, 100 - (missingLabels / formElementsCount * 100)) : 100;

  const invalidAriaScore = Math.max(0, 100 - (invalidAriaCount * 10));

  const issuesScore = Math.max(0, 100 - (issues.length * 5));

  const finalScore = Math.round(
    (missingAriaScore * 0.3) +
    (missingLabelsScore * 0.3) +
    (invalidAriaScore * 0.2) +
    (issuesScore * 0.2)
  );

  return {
    score: finalScore,
    missingAriaCount,
    missingLabels,
    invalidAriaCount,
    interactiveElementsCount,
    interactiveElementsWithAriaPercent,
    formElementsCount,
    formElementsWithLabelsPercent,
    issues
  };
}
