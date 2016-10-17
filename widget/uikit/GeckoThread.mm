#import "GeckoThread.h"

#include "application.ini.h"
#include "nsAppShell.h"
#include "nsXREAppData.h"
#include "nsXULAppAPI.h"
#include "nsIFile.h"

#include "mozilla/AppData.h"

static GeckoThread* sGeckoThread;

@interface GeckoThread(Private)

- (void)main;

@end

@implementation GeckoThread

@synthesize ready = mReady;

- (id)init {
  self = [super init];
  mCondition = [[NSCondition alloc] init];
  return self;
}

+ (GeckoThread*)sharedThread {
  return sGeckoThread;
}

+ (void)startup {
  if (sGeckoThread) {
    return;
  }

  sGeckoThread = [[GeckoThread alloc] init];
  [sGeckoThread start];
}

- (void)waitUntilReady {
  [mCondition lock];
  if (mReady) {
    [mCondition unlock];
    return;
  }

  while (!mReady) {
    [mCondition wait];
  }
  [mCondition unlock];
}

- (void)notifyReady {
  [mCondition lock];
  mReady = true;
  [mCondition broadcast];
  [mCondition unlock];
}

- (void)main
{
  mozilla::ScopedAppData appData(&sAppData);

  NSString* bundlePath = [[NSBundle bundleForClass:[GeckoThread class]] bundlePath];

  nsCOMPtr<nsIFile> greDir;
  nsresult rv = NS_NewNativeLocalFile(nsDependentCString([bundlePath UTF8String]), true,
                                      getter_AddRefs(greDir));
  if (NS_FAILED(rv)) {
    printf("Couldn't find the application directory.\n");
    return;
  }

  greDir->Append(NS_LITERAL_STRING("browser"));
  mozilla::SetStrongPtr(appData.xreDirectory, static_cast<nsIFile*>(greDir.get()));

  char *exePath = strdup([[[NSBundle mainBundle] executablePath] UTF8String]);
  XRE_main(1, &exePath, &appData, 0);
  free(exePath);

  printf_stderr("XRE_main exited!\n");
}

@end
