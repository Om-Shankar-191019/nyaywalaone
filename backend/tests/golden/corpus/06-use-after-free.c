#include <stdio.h>
#include <stdlib.h>

int main(void) {
    int a = 0, b = 0;
    if (scanf("%d %d", &a, &b) != 2) {
        return 1;
    }
    int *pair = malloc(2 * sizeof(int));
    if (pair == NULL) {
        return 1;
    }
    pair[0] = a;
    pair[1] = b;
    free(pair);
    printf("%d\n", pair[0] + pair[1]);
    return 0;
}
