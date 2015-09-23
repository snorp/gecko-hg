//
//  ViewController.m
//  GeckoViewSandbox
//
//  Created by James Willcox on 10/15/15.
//  Copyright © 2015 Mozilla. All rights reserved.
//

#import "ViewController.h"
#import <GeckoKit/GeckoKit.h>

@interface ViewController ()

@end

@implementation ViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    mViews = [[NSMutableArray alloc] init];
}

- (void)didReceiveMemoryWarning {
    [super didReceiveMemoryWarning];
    // Dispose of any resources that can be recreated.
}

- (IBAction)addWebView:(id)sender
{
    printf("Adding web view\n");

    int x = rand() % ((int)self.view.bounds.size.width - 200);
    int y = (rand() % ((int)self.view.bounds.size.height - 100)) + 100;

    GeckoWebView* view = [[GeckoWebView alloc] initWithFrame:CGRectMake(x, y, 200, 200)];

    NSURLRequest* req = [NSURLRequest requestWithURL:[NSURL URLWithString:@"about:mozilla"]];
    [view loadRequest:req];

    [self.view addSubview:view];
    [self.view bringSubviewToFront:view];
    [view becomeFirstResponder];

    [mViews insertObject:view atIndex:0];

}

- (IBAction)removeWebView:(id)sender
{
    if (mViews.count == 0) {
        return;
    }

    printf("Removing web view\n");
    GeckoWebView* view = [mViews objectAtIndex:0];
    [mViews removeObject:view];
    [view removeFromSuperview];
}

@end
